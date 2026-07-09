"""Self-hosted TTS (Kokoro) + STT (faster-whisper) service.

Mirrors the request/response shapes the Firebase Functions already send to
OpenRouter (see functions/index.js: ttsAudio, transcribeAudio), so swapping
the upstream URL there is close to a one-line change — no client-side (app)
changes needed at all.

Auth: a single shared secret (SELFHOST_TOKEN) checked as a Bearer header.
This app has no other access control — it must sit behind a firewall that
only allows the Firebase Functions egress plus your own IP for testing (see
../README.md), since this file alone does not rate-limit or IP-allowlist.
"""
import base64
import os
import tempfile

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

app = FastAPI()

SELFHOST_TOKEN = os.environ.get("SELFHOST_TOKEN", "")
if not SELFHOST_TOKEN:
    raise RuntimeError("SELFHOST_TOKEN env var is required — set it before starting the server.")


def check_auth(authorization: str | None):
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "Missing Bearer token")
    if authorization[len("Bearer "):] != SELFHOST_TOKEN:
        raise HTTPException(401, "Invalid token")


# ── Kokoro TTS ──────────────────────────────────────────────────────────
# Loaded lazily on first request so the container starts fast; the model
# files (~350MB) are baked into the image at build time (see Dockerfile).
_kokoro = None


def get_kokoro():
    global _kokoro
    if _kokoro is None:
        from kokoro_onnx import Kokoro
        _kokoro = Kokoro("/models/kokoro-v1.0.onnx", "/models/voices-v1.0.bin")
    return _kokoro


class SpeechRequest(BaseModel):
    model: str = "hexgrad/kokoro-82m"
    input: str
    voice: str = "af_heart"
    response_format: str = "wav"
    speed: float = 1.0


@app.post("/v1/audio/speech")
def speech(req: SpeechRequest, authorization: str | None = Header(default=None)):
    check_auth(authorization)
    if not req.input.strip():
        raise HTTPException(400, "Empty input text")
    kokoro = get_kokoro()
    samples, sample_rate = kokoro.create(req.input, voice=req.voice, speed=max(0.5, min(2.0, req.speed)))

    import io
    import soundfile as sf
    buf = io.BytesIO()
    sf.write(buf, samples, sample_rate, format="WAV")
    buf.seek(0)
    return Response(
        content=buf.read(),
        media_type="audio/wav",
        headers={"X-TTS-Voice": req.voice, "X-TTS-Engine": "kokoro-selfhost"},
    )


# ── faster-whisper STT ──────────────────────────────────────────────────
_whisper = None
WHISPER_MODEL_SIZE = os.environ.get("WHISPER_MODEL_SIZE", "base")


def get_whisper():
    global _whisper
    if _whisper is None:
        from faster_whisper import WhisperModel
        # int8 quantization keeps this well under 2GB RAM even for "small".
        _whisper = WhisperModel(WHISPER_MODEL_SIZE, device="cpu", compute_type="int8")
    return _whisper


class InputAudio(BaseModel):
    data: str
    format: str = "mp3"


class TranscriptionRequest(BaseModel):
    model: str = "whisper"
    input_audio: InputAudio
    language: str | None = None
    response_format: str = "verbose_json"
    timestamp_granularities: list[str] = []


@app.post("/v1/audio/transcriptions")
def transcriptions(req: TranscriptionRequest, authorization: str | None = Header(default=None)):
    check_auth(authorization)
    try:
        raw = base64.b64decode(req.input_audio.data)
    except Exception:
        raise HTTPException(400, "Invalid base64 audio")

    suffix = "." + (req.input_audio.format or "mp3").lstrip(".")
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=True) as f:
        f.write(raw)
        f.flush()
        model = get_whisper()
        segments_iter, info = model.transcribe(
            f.name,
            language=req.language or None,
            vad_filter=True,
        )
        segments = []
        full_text_parts = []
        for seg in segments_iter:
            text = seg.text.strip()
            if not text:
                continue
            full_text_parts.append(text)
            segments.append({"start": seg.start, "end": seg.end, "text": text})

    return {"text": " ".join(full_text_parts).strip(), "segments": segments, "language": info.language}


@app.get("/health")
def health():
    return {"ok": True}
