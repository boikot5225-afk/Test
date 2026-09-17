FROM python:3.11-slim

# espeak-ng: phonemizer backend kokoro-onnx needs for some languages.
# ffmpeg: faster-whisper/ctranslate2 audio decoding.
# cmake + g++: pyopenjtalk ships as a source tarball and builds on install; it
# is what gives Japanese the phonemes Kokoro's jf_/jm_ voices were trained on.
# Without it espeak-ng handles Japanese, and espeak cannot read kanji at all —
# it names them, so 朝 is spoken aloud as "Chinese letter".
RUN apt-get update && apt-get install -y --no-install-recommends \
    espeak-ng ffmpeg curl cmake g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
# misaki[ja] pulls `unidic`, a stub package whose dictionary is a separate ~1GB
# download that never happens here — and fugashi picks it over unidic-lite and
# then fails with "no such file or directory: .../unidic/dicdir/mecabrc".
# Dropping the stub leaves the complete lite dictionary in its place.
RUN pip install --no-cache-dir -r requirements.txt && \
    pip uninstall -y unidic && \
    python -c "from misaki import ja; ja.JAG2P()('\u4eca\u65e5')" 

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
