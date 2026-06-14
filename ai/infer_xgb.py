import sys
import json
import os
import tempfile
import joblib
import librosa
import numpy as np
from pathlib import Path

try:
    from pydub import AudioSegment
    PYDUB_AVAILABLE = True
except ImportError:
    PYDUB_AVAILABLE = False

SAMPLE_RATE      = 16000
N_MELS           = 128
N_FFT            = 1024
HOP_LENGTH       = 256

BASE           = Path(__file__).parent
MODEL_PATH     = BASE / "models" / "snore_xgb_model.joblib"
RF_MODEL_PATH  = BASE / "models" / "snore_rf_model.joblib"
LABEL_MAP_PATH = BASE / "models" / "label_map.json"

# Default configurations for XGBoost (3.0s duration, 128x188 mel shape)
clip_duration    = 3.0
expected_samples = int(SAMPLE_RATE * clip_duration)
mel_shape        = (128, 188)

model = None
using_rf = False

try:
    model = joblib.load(MODEL_PATH)
except Exception as e:
    sys.stderr.write(f"[WARNING] XGBoost model failed to load ({type(e).__name__}: {str(e)}).\n")
    sys.stderr.write("[WARNING] Falling back to Random Forest model (snore_rf_model.joblib)...\n")
    sys.stderr.flush()
    try:
        model = joblib.load(RF_MODEL_PATH)
        using_rf = True
        # Adjust dimensions for Random Forest model (2.0s duration, 128x126 mel shape)
        clip_duration = 2.0
        expected_samples = int(SAMPLE_RATE * clip_duration)
        mel_shape = (128, 126)
    except Exception as rf_err:
        sys.stderr.write(f"[ERROR] Both models failed to load. RF model error: {rf_err}\n")
        sys.stderr.flush()
        raise rf_err
with open(LABEL_MAP_PATH, encoding="utf-8") as f:
    label_map = {int(k): v for k, v in json.load(f).items()}

rev_map   = {v: k for k, v in label_map.items()}
snore_idx = rev_map.get("snore")

DISPLAY = {
    "snore":     "코골이 감지",
    "non_snore": "정상 수면",
}

# 클래스 민감도 가중치 — 높일수록 해당 클래스로 더 잘 판정
CLASS_WEIGHTS = {
    "snore":     0.5,
    "non_snore": 1.0,
}


def load_audio(audio_bytes: bytes) -> np.ndarray:
    is_wav = audio_bytes[:4] == b"RIFF"
    suffix = ".wav" if is_wav else ".webm"

    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(audio_bytes)
        tmp_path = tmp.name

    wav_path = None
    try:
        if is_wav:
            audio, _ = librosa.load(tmp_path, sr=SAMPLE_RATE, mono=True)
        else:
            if not PYDUB_AVAILABLE:
                raise RuntimeError("webm 처리에는 pydub과 ffmpeg가 필요합니다.")
            wav_path = tmp_path.replace(".webm", ".wav")
            seg = AudioSegment.from_file(tmp_path)
            seg = seg.set_frame_rate(SAMPLE_RATE).set_channels(1)
            seg.export(wav_path, format="wav")
            audio, _ = librosa.load(wav_path, sr=SAMPLE_RATE, mono=True)
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
        if wav_path and os.path.exists(wav_path):
            os.remove(wav_path)

    return audio.astype(np.float32)


def pad_or_trim(audio: np.ndarray, length: int = expected_samples) -> np.ndarray:
    if len(audio) < length:
        return np.pad(audio, (0, length - len(audio))).astype(np.float32)
    return audio[:length].astype(np.float32)


def audio_to_mel(audio: np.ndarray) -> np.ndarray:
    audio = pad_or_trim(audio)
    mel = librosa.feature.melspectrogram(
        y=audio, sr=SAMPLE_RATE, n_fft=N_FFT,
        hop_length=HOP_LENGTH, n_mels=N_MELS, power=2.0,
    )
    mel_db = librosa.power_to_db(mel, ref=np.max).astype(np.float32)
    mn, mx = mel_db.min(), mel_db.max()
    mel_db = (mel_db - mn) / (mx - mn) if mx - mn > 1e-8 else np.zeros_like(mel_db)

    th, tw = mel_shape
    h, w = mel_db.shape
    if h < th:
        mel_db = np.pad(mel_db, ((0, th - h), (0, 0)))
    else:
        mel_db = mel_db[:th, :]
    if w < tw:
        mel_db = np.pad(mel_db, ((0, 0), (0, tw - w)))
    else:
        mel_db = mel_db[:, :tw]

    return mel_db.astype(np.float32)


def extract_handcrafted(audio: np.ndarray) -> np.ndarray:
    rms       = float(np.sqrt(np.mean(audio ** 2)))
    zcr       = float(np.mean(librosa.feature.zero_crossing_rate(audio)))
    centroid  = float(np.mean(librosa.feature.spectral_centroid(y=audio, sr=SAMPLE_RATE)))
    rolloff   = float(np.mean(librosa.feature.spectral_rolloff(y=audio, sr=SAMPLE_RATE)))
    bandwidth = float(np.mean(librosa.feature.spectral_bandwidth(y=audio, sr=SAMPLE_RATE)))
    mfcc      = librosa.feature.mfcc(y=audio, sr=SAMPLE_RATE, n_mfcc=3).mean(axis=1).tolist()
    return np.array([rms, zcr, centroid, rolloff, bandwidth] + mfcc, dtype=np.float32)


def extract_feature(audio: np.ndarray) -> np.ndarray:
    audio = pad_or_trim(audio)
    mel   = audio_to_mel(audio).reshape(-1)
    hand  = extract_handcrafted(audio)
    return np.concatenate([mel, hand]).reshape(1, -1)


def main():
    audio_bytes = sys.stdin.buffer.read()
    audio       = load_audio(audio_bytes)
    feature     = extract_feature(audio)

    probs    = model.predict_proba(feature)[0]
    weighted = np.array([
        p * CLASS_WEIGHTS.get(label_map[i], 1.0)
        for i, p in enumerate(probs)
    ])
    pred_idx   = int(np.argmax(weighted))
    pred_label = label_map[pred_idx]
    snore_prob = float(probs[snore_idx]) if snore_idx is not None else 0.0
    rms        = float(np.sqrt(np.mean(audio ** 2)))

    result = {
        "prediction": pred_label,
        "display":    DISPLAY.get(pred_label, pred_label),
        "snore_prob": round(snore_prob, 4),
        "rms":        round(rms, 6),
    }
    sys.stdout.buffer.write(json.dumps(result, ensure_ascii=False).encode("utf-8"))
    sys.stdout.buffer.flush()


if __name__ == "__main__":
    main()
