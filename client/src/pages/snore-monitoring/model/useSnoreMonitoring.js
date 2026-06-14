import { useState, useRef, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";

import { useAuth } from "@/shared/lib/auth";
import { useModal } from "@/shared/lib/modal";
import { useAsync } from "@/shared/api";
import {
  checkMicPermission,
  requestMicPermission,
} from "@/shared/lib/audio";

import { MONITORING_STATUS } from "./monitoringConfig";
import { useAlarm } from "./useAlarm";
import { useAudioRecorder } from "./useAudioRecorder";

import {
  createAlarmLog,
  createSnoreEvent,
  createSession,
  updateSession,
  predictSnore,
} from "@/pages/snore-monitoring/api";
import { useSnoreDetection } from "./useSnoreDetection";

const ALARM_COOLDOWN_MS = 30 * 60 * 1000; // 30분

export const useSnoreMonitoring = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { openModal, closeModal } = useModal();
  const { playAlarm, stopAlarm, isPlayingAlarm } = useAlarm();

  // --- API 비동기 훅 ---
  const { execute: createSessionAsync, isLoading } = useAsync(createSession);
  const { execute: updateSessionAsync } = useAsync(updateSession);
  const { execute: createSnoreEventAsync } = useAsync(createSnoreEvent);
  const { execute: createAlarmLogAsync } = useAsync(createAlarmLog);
  const { execute: predictSnoreAsync } = useAsync(predictSnore);

  // --- 상태 관리 ---
  const [monitoringStatus, setMonitoringStatus] = useState(
    MONITORING_STATUS.IDLE,
  );
  const [isCooldown, setIsCooldown] = useState(false);

  // --- Refs ---
  const sessionIdRef = useRef(null);
  const reportIdRef = useRef(null);
  const cooldownTimerRef = useRef(null);

  const lastAlarmTimeRef = useRef(0);
  const patternValidSince = useRef(new Date());
  const alarmActiveRef = useRef(user?.alarmCondition !== "3");

  // --- 헬퍼 함수 ---
  const initValidRefs = useCallback(() => {
    snoreStreakRef.current = 0;
    patternValidSince.current = new Date();
  }, []);

  const handleMicPermission = async () => {
    const { state } = await checkMicPermission();
    if (state === "granted") return true;

    return new Promise((resolve) => {
      if (state === "prompt") {
        openModal({
          title: "마이크 권한 요청",
          description:
            "코골이 감지를 위해 마이크 권한이 필요해요.\n녹음 데이터는 저장되지 않고 분석에만 사용돼요.",
          onConfirm: async () => {
            const granted = await requestMicPermission();
            resolve(granted);
          },
          onCancel: () => resolve(false),
        });
      } else if (state === "denied") {
        openModal({
          title: "마이크 권한 재설정 요청",
          description:
            "브라우저에서 마이크 권한을 다시 허용해야\n모니터링을 시작할 수 있어요.",
          onConfirm: () => resolve(false),
          showCancel: false,
        });
      } else {
        resolve(false);
      }
    });
  };

  /**
   * 세션 컨트롤 로직
   */
  const startSession = async () => {
    const granted = await handleMicPermission();
    if (!granted) return;

    const response = await createSessionAsync({ startedAt: new Date() });
    if (!response?.success) return;

    sessionIdRef.current = response.data.sessionId;
    setMonitoringStatus(MONITORING_STATUS.RUNNING);
    await startRecording();
  };

  /**
   * 모니터링 세션 종료
   */
  const stopSession = async () => {
    // 1. 상태를 먼저 '종료 중'으로 변경하여 알람 트리거 useEffect를 즉시 차단
    setMonitoringStatus(MONITORING_STATUS.FINISHING);

    // 2. 알람 및 타이머 관련 상태 완전 초기화
    stopAlarm();
    setIsCooldown(false);
    if (cooldownTimerRef.current) {
      clearTimeout(cooldownTimerRef.current);
      cooldownTimerRef.current = null;
    }

    // 3. 녹음 중지 및 남은 데이터 저장
    stopRecording();
    await saveSnoreStreak();

    // 4. 서버 세션 업데이트
    if (sessionIdRef.current) {
      const response = await updateSessionAsync(sessionIdRef.current, {
        endedAt: new Date(),
      });

      if (!response.success) return;

      reportIdRef.current = response.data.reportId;

      // 5. 최종 정지 상태로 변경
      setMonitoringStatus(MONITORING_STATUS.STOPPED);
    }
  };

  const handleToggleMonitoring = async () => {
    switch (monitoringStatus) {
      case MONITORING_STATUS.IDLE:
        await startSession();
        break;
      case MONITORING_STATUS.RUNNING:
        openModal({
          title: "모니터링을 종료할까요?",
          description:
            "확인을 누르면 모니터링을 종료하고\n수면 분석이 시작돼요.",
          onConfirm: async () => {
            closeModal();
            await stopSession();
          },
        });
        break;
      case MONITORING_STATUS.STOPPED:
        navigate(`/history/${reportIdRef.current || ""}`);
        break;
      default:
        break;
    }
  };

  const handleToggleCooldown = () => {
    if (monitoringStatus !== MONITORING_STATUS.RUNNING) return;

    if (isPlayingAlarm()) {
      stopAlarm();
      return;
    }

    setIsCooldown((prev) => {
      const nextState = !prev;
      if (cooldownTimerRef.current) {
        clearTimeout(cooldownTimerRef.current);
        cooldownTimerRef.current = null;
      }

      if (nextState) {
        // 쿨다운 켜기
        cooldownTimerRef.current = setTimeout(
          () => setIsCooldown(false),
          ALARM_COOLDOWN_MS,
        );
      } else {
        // 쿨다운 끄기
        initValidRefs();
      }
      return nextState;
    });
  };

  // --- 알람 발생 유틸 함수 ---
  const triggerAlarmWithCooldown = useCallback(async () => {
    const now = Date.now();
    if (isCooldown && now - lastAlarmTimeRef.current < ALARM_COOLDOWN_MS)
      return;

    lastAlarmTimeRef.current = now;
    setIsCooldown(true);
    playAlarm();

    cooldownTimerRef.current = setTimeout(
      () => setIsCooldown(false),
      ALARM_COOLDOWN_MS,
    );

    if (sessionIdRef.current) {
      await createAlarmLogAsync(sessionIdRef.current, {
        triggeredAt: new Date(),
      });
    }
  }, [isCooldown, playAlarm, createAlarmLogAsync]);

  // --- hooks ---
  const { processAudio, saveSnoreStreak, snoreDetections, snoreStreakRef } =
    useSnoreDetection({
      predictSnoreAsync,
      createSnoreEventAsync,
      sessionIdRef,
    });

  const { startRecording, stopRecording } = useAudioRecorder({
    onAudioChunk: processAudio,
  });

  // --- 알람 조건 감시 및 트리거 효과 ---
  useEffect(() => {
    if (monitoringStatus !== MONITORING_STATUS.RUNNING) return;
    if (!alarmActiveRef.current) return;

    const condition = String(user?.alarmCondition);

    // 1. 지속 시간 기반 알람 (연속 4회 감지 = 약 12초)
    if (condition === "1" && snoreStreakRef.current > 3) {
      triggerAlarmWithCooldown();
      return;
    }

    // 2. 빈도 패턴 기반 알람 (1분 내 5회 이상)
    if (condition === "2" && snoreDetections.length >= 5) {
      const lastSnoreTime = new Date(
        snoreDetections.at(-1)?.startedAt,
      ).getTime();
      const fifthLastSnoreTime = new Date(
        snoreDetections.at(-5)?.startedAt,
      ).getTime();

      if (
        fifthLastSnoreTime >= patternValidSince.current.getTime() &&
        lastSnoreTime - fifthLastSnoreTime < 60 * 1000
      ) {
        triggerAlarmWithCooldown();
      }
    }
  }, [
    snoreDetections,
    user?.alarmCondition,
    monitoringStatus,
    triggerAlarmWithCooldown,
  ]);

  useEffect(() => {
    const handleBeforeUnload = (e) => {
      if (monitoringStatus === MONITORING_STATUS.RUNNING) {
        e.preventDefault();
        // 현대 브라우저에서는 기본 경고창이 출력되며, 아래 문자열은 무시되지만 하위 호환성을 위해 작성합니다.
        e.returnValue = "";
      }
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [monitoringStatus]);

  // --- 언마운트 클린업 ---
  useEffect(() => {
    return () => {
      stopRecording();
      if (cooldownTimerRef.current) clearTimeout(cooldownTimerRef.current);
      stopAlarm();
    };
  }, [stopRecording, stopAlarm]);

  return {
    monitoringStatus,
    snoreDetections,
    isCooldown,
    isLoading,
    user,
    handleToggleMonitoring,
    handleToggleCooldown,
  };
};
