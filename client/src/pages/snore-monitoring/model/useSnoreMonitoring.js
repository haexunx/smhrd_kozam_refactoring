import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";

import { useAuth } from "@/shared/lib/auth";
import { useModal } from "@/shared/lib/modal";
import { useAsync } from "@/shared/api";

import { MONITORING_STATUS } from "./monitoringConfig";
import { useAlarm } from "./useAlarm";
import { useSnoreDetection } from "./useSnoreDetection";
import { useAudioRecorder } from "./useAudioRecorder";
import { useMonitoringSession } from "./useMonitoringSession";
import { useAlertManager } from "./useAlertManager";
import { useMicPermission } from "./useMicPermission";

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

  // --- API 비동기 훅 ---
  const { execute: createSessionAsync, isLoading } = useAsync(createSession);
  const { execute: updateSessionAsync } = useAsync(updateSession);
  const { execute: createSnoreEventAsync } = useAsync(createSnoreEvent);
  const { execute: createAlarmLogAsync } = useAsync(createAlarmLog);
  const { execute: predictSnoreAsync } = useAsync(
    IS_TEST_MODE ? mockPredictSnore : predictSnore,
  );

  // --- Refs ---
  const sessionIdRef = useRef(null);
  const reportIdRef = useRef(null);

  // --- hooks ---
  const { playAlarm, stopAlarm, isPlayingAlarm } = useAlarm();

  const { processAudio, saveSnoreStreak, snoreDetections, snoreStreakRef } =
    useSnoreDetection({
      predictSnoreAsync,
      createSnoreEventAsync,
      sessionIdRef,
    });

  const { startRecording, stopRecording } = useAudioRecorder({
    onAudioChunk: processAudio,
  });

  const { monitoringStatus, startSession, stopSession } = useMonitoringSession({
    sessionIdRef,
    reportIdRef,
    createSessionAsync,
    updateSessionAsync,
    startRecording,
    stopRecording,
    stopAlarm,
    saveSnoreStreak,
  });

  const { isCooldown, handleToggleCooldown } = useAlertManager({
    playAlarm,
    stopAlarm,
    isPlayingAlarm,
    monitoringStatus,
    sessionIdRef,
    user,
    snoreDetections,
    snoreStreakRef,
    createAlarmLogAsync,
  });

  const { handleMicPermission } = useMicPermission();

  // --- 모니터링 토글 핸들러 ---
  const handleToggleMonitoring = async () => {
    switch (monitoringStatus) {
      case MONITORING_STATUS.IDLE:
        const granted = await handleMicPermission();

        if (!granted) return;

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

  // --- 브라우저 새로고침 확인 ---
  useEffect(() => {
    const handleBeforeUnload = (e) => {
      if (monitoringStatus === MONITORING_STATUS.RUNNING) {
        e.preventDefault();
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
