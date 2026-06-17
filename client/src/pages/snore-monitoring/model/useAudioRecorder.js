import { useRef, useCallback } from "react";

const RECORDING_INTERVAL_MS = 3000;

export const useAudioRecorder = ({ onAudioChunk }) => {
  const audioContextRef = useRef(null);
  const streamRef = useRef(null);
  const workletNodeRef = useRef(null);
  const pcmBufferRef = useRef([]);

  const startRecording = useCallback(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
    });
    streamRef.current = stream;

    const AudioCtx = window.AudioContext || window.webkitAudioContext;

    const audioContext = new AudioCtx();
    audioContextRef.current = audioContext;

    const sampleRate = audioContext.sampleRate;

    const samplesNeeded = Math.round(
      (sampleRate * RECORDING_INTERVAL_MS) / 1000,
    );

    const processorCode = `
      class PCMProcessor extends AudioWorkletProcessor {
        process(inputs) {
          const ch = inputs[0]?.[0];
          if (ch) this.port.postMessage(ch.slice());
          return true;
        }
      }

      registerProcessor(
        "pcm-processor",
        PCMProcessor
      );
    `;

    const blobUrl = URL.createObjectURL(
      new Blob([processorCode], {
        type: "application/javascript",
      }),
    );

    await audioContext.audioWorklet.addModule(blobUrl);

    URL.revokeObjectURL(blobUrl);

    const source = audioContext.createMediaStreamSource(stream);
    const workletNode = new AudioWorkletNode(audioContext, "pcm-processor");

    workletNodeRef.current = workletNode;

    source.connect(workletNode);

    pcmBufferRef.current = [];

    workletNode.port.onmessage = async (event) => {
      pcmBufferRef.current.push(event.data);

      const total = pcmBufferRef.current.reduce(
        (sum, chunk) => sum + chunk.length,
        0,
      );

      if (total >= samplesNeeded) {
        const merged = new Float32Array(total);

        let offset = 0;

        for (const chunk of pcmBufferRef.current) {
          merged.set(chunk, offset);
          offset += chunk.length;
        }

        pcmBufferRef.current = [];

        await onAudioChunk(merged.subarray(0, samplesNeeded), sampleRate);
      }
    };
  }, [onAudioChunk]);

  const stopRecording = useCallback(() => {
    if (workletNodeRef.current) {
      workletNodeRef.current.port.onmessage = null;
      workletNodeRef.current.disconnect();
      workletNodeRef.current = null;
    }

    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());

      streamRef.current = null;
    }

    pcmBufferRef.current = [];
  }, []);

  return {
    startRecording,
    stopRecording,
  };
};
