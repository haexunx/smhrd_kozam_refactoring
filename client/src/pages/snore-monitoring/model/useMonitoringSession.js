import { useState } from "react";

import { MONITORING_STATUS } from "./monitoringConfig";

export const useMonitoringSession = ({
  sessionIdRef,
  reportIdRef,
  createSessionAsync,
  updateSessionAsync,
  startRecording,
  stopRecording,
  stopAlarm,
  saveSnoreStreak,
}) => {
  const [monitoringStatus, setMonitoringStatus] = useState(
    MONITORING_STATUS.IDLE,
  );

  const startSession = async () => {
    const response = await createSessionAsync({
      startedAt: new Date(),
    });

    if (!response?.success) return false;

    sessionIdRef.current = response.data.sessionId;

    setMonitoringStatus(MONITORING_STATUS.RUNNING);

    await startRecording();

    return true;
  };

  const stopSession = async () => {
    setMonitoringStatus(MONITORING_STATUS.FINISHING);

    stopAlarm();

    stopRecording();

    await saveSnoreStreak();

    if (!sessionIdRef.current) return false;

    const response = await updateSessionAsync(sessionIdRef.current, {
      endedAt: new Date(),
    });

    if (!response?.success) return false;

    reportIdRef.current = response.data.reportId;

    setMonitoringStatus(MONITORING_STATUS.STOPPED);

    return true;
  };

  return {
    monitoringStatus,
    startSession,
    stopSession,
  };
};
