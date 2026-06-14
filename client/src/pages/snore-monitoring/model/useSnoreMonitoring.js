import { useState, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";

import { useAuth } from "@/shared/lib/auth";
import { useModal } from "@/shared/lib/modal";
import { useAsync } from "@/shared/api";
import { checkMicPermission, requestMicPermission } from "@/shared/lib/audio";

import { MONITORING_STATUS } from "./monitoringConfig";
import { useAudioRecorder } from "./useAudioRecorder";
import { useSnoreDetection } from "./useSnoreDetection";
import { useAlertManager } from "./useAlertManager";

import {
  createAlarmLog,
  createSnoreEvent,
  createSession,
  updateSession,
  predictSnore,
} from "@/pages/snore-monitoring/api";

export const useSnoreMonitoring = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { openModal, closeModal } = useModal();

  // --- 테스트 모드 설정 (true로 설정 시 무조건 코골이로 감지합니다) ---
  const IS_TEST_MODE = true;

  const mockPredictSnore = async () => {
    // 0.5초 대기 후 강제 코골이 응답 반환
    await new Promise((resolve) => setTimeout(resolve, 500));
    console.log("[Test Mode] 코골이 강제 감지 (snore)");
    return {
      success: true,
      data: {
        predicted: "snore",
        snoreProb: 0.98,
        rms: 0.08,
        intensity: "high",
      },
    };
  };

  // --- API 비동기 훅 ---
  const { execute: createSessionAsync, isLoading } = useAsync(createSession);
  const { execute: updateSessionAsync } = useAsync(updateSession);
  const { execute: createSnoreEventAsync } = useAsync(createSnoreEvent);
  const { execute: createAlarmLogAsync } = useAsync(createAlarmLog);
  const { execute: predictSnoreAsync } = useAsync(
    IS_TEST_MODE ? mockPredictSnore : predictSnore
  );

  // --- 상태 관리 ---
  const [monitoringStatus, setMonitoringStatus] = useState(
    MONITORING_STATUS.IDLE,
  );

  // --- Refs ---
  const sessionIdRef = useRef(null);
  const reportIdRef = useRef(null);

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
    setMonitoringStatus(MONITORING_STATUS.FINISHING);

    stopAlarm();

    stopRecording();

    await saveSnoreStreak();

    if (sessionIdRef.current) {
      const response = await updateSessionAsync(sessionIdRef.current, {
        endedAt: new Date(),
      });

      if (!response.success) return;

      reportIdRef.current = response.data.reportId;

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

  const { isCooldown, handleToggleCooldown, stopAlarm } = useAlertManager({
    monitoringStatus,
    sessionIdRef,
    user,
    snoreDetections,
    snoreStreakRef,
    createAlarmLogAsync,
  });

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
