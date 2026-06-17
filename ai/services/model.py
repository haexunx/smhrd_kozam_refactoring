import joblib
import json
import numpy as np
import librosa
from pathlib import Path
import os

# snore_xgb.py 상수와 동일하게 맞춤 (3초 클립, 128×188 mel)
SAMPLE_RATE = 16000
CLIP_DURATION = 3.0
EXPECTED_SAMPLES = int(SAMPLE_RATE * CLIP_DURATION)
N_MELS = 128
N_FFT = 1024
HOP_LENGTH = 256

class SnoreModel:
    def __init__(self, model_path="models/snore_xgb_model.joblib", label_map_path="models/label_map.json"):
        # 절대 경로로 변환하여 안정성을 확보합니다.
        base_path = Path(__file__).resolve().parent.parent
        self.model_path = base_path / model_path
        self.rf_model_path = base_path / "models" / "snore_rf_model.joblib"
        self.label_map_path = base_path / label_map_path
        self.model = None
        self.label_map = None

        # 기본 설정 (XGBoost - 3초, 128x188 mel)
        self.clip_duration = 3.0
        self.expected_samples = int(SAMPLE_RATE * self.clip_duration)
        self.mel_shape = (128, 188)
        self.using_rf = False

        self.load_model()

    def load_model(self):
        try:
            if self.model_path.exists() and self.label_map_path.exists():
                self.model = joblib.load(self.model_path)
                with open(self.label_map_path, "r", encoding="utf-8") as f:
                    self.label_map = {int(k): v for k, v in json.load(f).items()}
                print(f"[SUCCESS] Model loaded successfully from {self.model_path}")
            else:
                raise FileNotFoundError("XGBoost model files not found")
        except Exception as e:
            print(f"[WARN] Failed to load XGBoost model: {e}")
            print("[WARN] Falling back to Random Forest model...")
            try:
                if self.rf_model_path.exists() and self.label_map_path.exists():
                    self.model = joblib.load(self.rf_model_path)
                    with open(self.label_map_path, "r", encoding="utf-8") as f:
                        self.label_map = {int(k): v for k, v in json.load(f).items()}
                    self.using_rf = True
                    self.clip_duration = 2.0
                    self.expected_samples = int(SAMPLE_RATE * self.clip_duration)
                    self.mel_shape = (128, 126)
                    print(f"[SUCCESS] Fallback Random Forest model loaded successfully from {self.rf_model_path}")
                else:
                    print(f"[ERROR] Both model files not found. Expected RF model at: {self.rf_model_path}")
            except Exception as rf_err:
                print(f"[ERROR] Error loading fallback Random Forest model: {rf_err}")

    def pad_or_trim(self, audio: np.ndarray, target_length: int = None) -> np.ndarray:
        if target_length is None:
            target_length = self.expected_samples
        if len(audio) < target_length:
            audio = np.pad(audio, (0, target_length - len(audio)), mode="constant")
        elif len(audio) > target_length:
            audio = audio[:target_length]
        return audio

    def audio_to_mel(self, audio: np.ndarray, sr: int = SAMPLE_RATE) -> np.ndarray:
        mel = librosa.feature.melspectrogram(
            y=audio, sr=sr, n_fft=N_FFT, hop_length=HOP_LENGTH,
            n_mels=N_MELS, power=2.0,
        )
        mel_db = librosa.power_to_db(mel, ref=np.max).astype(np.float32)
        mel_min, mel_max = mel_db.min(), mel_db.max()
        if mel_max - mel_min > 1e-8:
            mel_db = (mel_db - mel_min) / (mel_max - mel_min)
        else:
            mel_db = np.zeros_like(mel_db)
        return mel_db

    def ensure_shape(self, mel: np.ndarray, target_shape=None) -> np.ndarray:
        if target_shape is None:
            target_shape = self.mel_shape
        th, tw = target_shape
        h, w = mel.shape
        if h < th:
            mel = np.pad(mel, ((0, th - h), (0, 0)), mode="constant")
        elif h > th:
            mel = mel[:th, :]
        if w < tw:
            mel = np.pad(mel, ((0, 0), (0, tw - w)), mode="constant")
        elif w > tw:
            mel = mel[:, :tw]
        return mel

    def extract_handcrafted(self, audio: np.ndarray, sr: int = SAMPLE_RATE) -> np.ndarray:
        rms = float(np.sqrt(np.mean(audio ** 2)))
        zcr = float(np.mean(librosa.feature.zero_crossing_rate(audio)))
        centroid = float(np.mean(librosa.feature.spectral_centroid(y=audio, sr=sr)))
        rolloff = float(np.mean(librosa.feature.spectral_rolloff(y=audio, sr=sr)))
        bandwidth = float(np.mean(librosa.feature.spectral_bandwidth(y=audio, sr=sr)))
        mfcc = librosa.feature.mfcc(y=audio, sr=sr, n_mfcc=3).mean(axis=1).tolist()
        return np.array([rms, zcr, centroid, rolloff, bandwidth] + mfcc, dtype=np.float32)

    def extract_feature_from_clip(self, audio: np.ndarray) -> np.ndarray:
        audio = self.pad_or_trim(audio)
        mel = self.ensure_shape(self.audio_to_mel(audio))
        flat = mel.reshape(-1).astype(np.float32)
        hand = self.extract_handcrafted(audio)
        return np.concatenate([flat, hand])

    # 🎯 윈도우 정렬/들여쓰기 왜곡을 완전 통일한 예측 함수 영역
    def predict(self, audio_data: np.ndarray):
        if self.model is None:
            return {"error": "Model not loaded"}

        rms = float(np.sqrt(np.mean(audio_data ** 2)))
        print(f"[DEBUG] audio shape={audio_data.shape}, rms={rms:.6f}, samples_nonzero={np.count_nonzero(audio_data)}", flush=True)
        if rms < 0.005:
            print(f"[DEBUG] Silent audio (rms={rms:.6f}) → returning non_snore", flush=True)
            return {
                "predicted": "non_snore",
                "snore_prob": 0.0,
                "rms": round(rms, 6),
                "intensity": "normal",
            }

        try:
            # 안전하게 오디오 피처를 추출하고 2차원으로 정렬합니다.
            feature = self.extract_feature_from_clip(audio_data).reshape(1, -1)
            probs = self.model.predict_proba(feature)[0]
            pred_idx = int(self.model.predict(feature)[0])
            pred_label = self.label_map[pred_idx]
            
            # 라벨 맵에서 코골이 인덱스 식별
            snore_idx = None
            for k, v in self.label_map.items():
                if v == "snore":
                    snore_idx = k
                    break
            
            snore_prob = float(probs[snore_idx]) if snore_idx is not None else 0.0

            # 기본 강도 및 라벨 설정
            intensity = "normal" 
            
            # 코골이 판단 시 강도 스코어 계산 
            if pred_label == "snore":
                # 수치가 높으면 high, 낮으면 low로 텍스트 분기 처리 (기존 Node.js나 React 요구 스펙에 맞게 조정 가능)
                calculated_score = 0.5 * snore_prob + 0.3 * min(rms / 0.1, 1.0)
                intensity = "high" if calculated_score > 0.4 else "low"

            print(f"[DEBUG] predicted={pred_label}, snore_prob={snore_prob:.4f}, rms={rms:.6f}", flush=True)
            return {
                "predicted": pred_label,
                "snore_prob": round(snore_prob, 4),
                "rms": round(rms, 6),
                "intensity": intensity
            }
        except Exception as e:
            return {"error": f"Internal prediction calculation error: {str(e)}"}

# 클래스 외부 선언 정의 (맨 왼쪽 벽에 붙여 씁니다)
snore_model = SnoreModel()