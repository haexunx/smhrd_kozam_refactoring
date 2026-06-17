import { useState, useRef, useEffect, useCallback } from "react";

import { MONITORING_STATUS } from "./monitoringConfig";

const ALARM_COOLDOWN_MS = 30 * 60 * 1000;

export const useAlertManager = ({
  playAlarm,
  stopAlarm,
  isPlayingAlarm,
  monitoringStatus,
  user,
  sessionIdRef,
  snoreDetections,
  snoreStreakRef,
  createAlarmLogAsync,
}) => {
  const [isCooldown, setIsCooldown] = useState(false);

  const cooldownTimerRef = useRef(null);
  const lastAlarmTimeRef = useRef(0);
  const patternValidSince = useRef(new Date());

  const isAlarmEnabled = user?.alarmCondition !== "3";

  const initValidRefs = useCallback(() => {
    snoreStreakRef.current = 0;
    patternValidSince.current = new Date();
  }, [snoreStreakRef]);

  const handleToggleCooldown = useCallback(() => {
    if (monitoringStatus !== MONITORING_STATUS.RUNNING) return;

    if (isPlayingAlarm()) {
      stopAlarm();
      return;
    }

    setIsCooldown((prev) => {
      const next = !prev;

      if (cooldownTimerRef.current) {
        clearTimeout(cooldownTimerRef.current);
      }

      if (next) {
        cooldownTimerRef.current = setTimeout(
          () => setIsCooldown(false),
          ALARM_COOLDOWN_MS,
        );
      } else {
        initValidRefs();
      }

      return next;
    });
  }, [monitoringStatus, stopAlarm, isPlayingAlarm, initValidRefs]);

  const triggerAlarmWithCooldown = useCallback(async () => {
    const now = Date.now();

    if (isCooldown && now - lastAlarmTimeRef.current < ALARM_COOLDOWN_MS) {
      return;
    }

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
  }, [isCooldown, playAlarm, createAlarmLogAsync, sessionIdRef]);

  useEffect(() => {
    if (monitoringStatus !== MONITORING_STATUS.RUNNING) {
      return;
    }

    if (!isAlarmEnabled) {
      return;
    }

    const condition = String(user?.alarmCondition);

    if (condition === "1" && snoreStreakRef.current > 3) {
      triggerAlarmWithCooldown();
      return;
    }

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
    monitoringStatus,
    user?.alarmCondition,
    isAlarmEnabled,
    snoreDetections,
    snoreStreakRef,
    triggerAlarmWithCooldown,
  ]);

  useEffect(() => {
    return () => {
      stopAlarm();

      if (cooldownTimerRef.current) {
        clearTimeout(cooldownTimerRef.current);
      }
    };
  }, [stopAlarm]);

  return {
    isCooldown,
    handleToggleCooldown,
  };
};
