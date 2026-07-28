FROM python:3.11-slim

# espeak-ng: phonemizer backend kokoro-onnx needs for some languages.
# ffmpeg: faster-whisper/ctranslate2 audio decoding.
RUN apt-get update && apt-get install -y --no-install-recommends \
    espeak-ng ffmpeg curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Kokoro model weights (~350MB total), baked into the image so container
# start doesn't need network access. If these URLs 404, check the current
# release assets at https://github.com/thewh1teagle/kokoro-onnx/releases
RUN mkdir -p /models && \
    curl -L -o /models/kokoro-v1.0.onnx \
      https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx && \
    curl -L -o /models/voices-v1.0.bin \
      https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin

COPY app.py .

ENV WHISPER_MODEL_SIZE=base
EXPOSE 8080
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8080"]
