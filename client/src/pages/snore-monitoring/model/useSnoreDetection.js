import { useState, useRef, useCallback } from "react";

import { float32ArrayToWav } from "@/shared/lib/audio";

const SNORE_GAP_LIMIT_SECONDS = 30;
const SNORE_MIN_DURATION_SECONDS = 10;

export const useSnoreDetection = ({
  predictSnoreAsync,
  createSnoreEventAsync,
  sessionIdRef,
}) => {
  const [snoreDetections, setSnoreDetections] = useState([]);

  const snoreStreakRef = useRef(0);

  const currentStreakRef = useRef({
    startedAt: null,
    lastDetectedAt: null,
    confidences: [],
  });

  const isProcessingAudioRef = useRef(false);

  const saveSnoreStreak = useCallback(async () => {
    const {
      startedAt,
      lastDetectedAt,
      confidences,
    } = currentStreakRef.current;

    if (!startedAt || !lastDetectedAt) return;

    const durationSeconds =
      (lastDetectedAt.getTime() -
        startedAt.getTime()) /
      1000;

    if (
      durationSeconds >= SNORE_MIN_DURATION_SECONDS &&
      sessionIdRef.current
    ) {
      const avgConfidence =
        confidences.reduce((a, b) => a + b, 0) /
        confidences.length;

      await createSnoreEventAsync(
        sessionIdRef.current,
        {
          startTime: startedAt,
          endTime: lastDetectedAt,
          avgConfidence: Number(
            avgConfidence.toFixed(2),
          ),
        },
      );
    }

    currentStreakRef.current = {
      startedAt: null,
      lastDetectedAt: null,
      confidences: [],
    };
  }, [
    createSnoreEventAsync,
    sessionIdRef,
  ]);

  const processAudio = useCallback(
    async (samples, sampleRate) => {
      if (!samples?.length) return;

      if (isProcessingAudioRef.current)
        return;

      isProcessingAudioRef.current = true;

      try {
        const wavBlob =
          float32ArrayToWav(
            samples,
            sampleRate,
          );

        const formData = new FormData();

        formData.append(
          "audio",
          wavBlob,
          "recording.wav",
        );

        const response =
          await predictSnoreAsync(formData);

        if (!response?.success) return;

        const now = new Date();

        const isSnore =
          response.data.predicted === "snore";

        const confidence =
          response.data.snoreProb || 1.0;

        if (isSnore) {
          if (
            !currentStreakRef.current.startedAt
          ) {
            currentStreakRef.current = {
              startedAt: now,
              lastDetectedAt: now,
              confidences: [confidence],
            };
          } else {
            currentStreakRef.current.lastDetectedAt =
              now;

            currentStreakRef.current.confidences.push(
              confidence,
            );
          }

          setSnoreDetections((prev) => [
            ...prev,
            {
              startedAt: now,
              confidence,
            },
          ]);

          snoreStreakRef.current += 1;
        } else {
          snoreStreakRef.current = 0;

          if (
            currentStreakRef.current.startedAt
          ) {
            const gapSeconds =
              (currentStreakRef.current.lastDetectedAt.getTime() -
                currentStreakRef.current.startedAt.getTime()) /
              1000;

            if (
              gapSeconds >
              SNORE_GAP_LIMIT_SECONDS
            ) {
              await saveSnoreStreak();
            }
          }
        }
      } finally {
        isProcessingAudioRef.current = false;
      }
    },
    [predictSnoreAsync, saveSnoreStreak],
  );

  return {
    processAudio,
    saveSnoreStreak,
    snoreDetections,
    snoreStreakRef,
  };
};