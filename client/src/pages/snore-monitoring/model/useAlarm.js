import { useRef, useCallback, useEffect } from "react";
import birdsSound from "@/shared/assets/sounds/birdsSinging.mp3";

const ALARM_SOUNDS = {
  bird: birdsSound,
};

export const useAlarm = (soundType = "bird") => {
  const audioRef = useRef(null);
  const isPlayingRef = useRef(false);

  const audioUrl = ALARM_SOUNDS[soundType] || ALARM_SOUNDS.bird;

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      isPlayingRef.current = false;
    }

    audioRef.current = new Audio(audioUrl);
    audioRef.current.loop = false;

    // Reset playing state when audio playback naturally ends
    const handleAudioEnded = () => {
      isPlayingRef.current = false;
    };
    audioRef.current.addEventListener("ended", handleAudioEnded);

    return () => {
      if (audioRef.current) {
        audioRef.current.removeEventListener("ended", handleAudioEnded);
        audioRef.current.pause();
        audioRef.current = null;
        isPlayingRef.current = false;
      }
    };
  }, [audioUrl]);

  const playAlarm = useCallback(async () => {
    if (!audioRef.current || isPlayingRef.current) {
      return;
    }
    try {
      isPlayingRef.current = true;
      audioRef.current.currentTime = 0;
      await audioRef.current.play();
    } catch (error) {
      isPlayingRef.current = false;
      console.error("[useAlarm] 오디오 재생 실패:", error);
    }
  }, []);

  const stopAlarm = useCallback(() => {
    if (audioRef.current && isPlayingRef.current) {
      audioRef.current.pause();
      isPlayingRef.current = false;
    }
  }, []);

  const isPlayingAlarm = () => isPlayingRef.current;

  return { playAlarm, stopAlarm, isPlayingAlarm };
};
