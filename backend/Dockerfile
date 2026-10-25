# Build context is the repository root (Railway uploads the whole repo).

# Piper TTS (linux x86_64) and three English voices, pinned by version and SHA-256.
FROM node:24-bookworm-slim AS piper
ARG PIPER_VERSION=2023.11.14-2
ARG PIPER_SHA256=a50cb45f355b7af1f6d758c1b360717877ba0a398cc8cbe6d2a7a3a26e225992
# rhasspy/piper-voices commit on Hugging Face
ARG VOICES_REV=c10ece1aade47bb51c153c893d14e5bf8e5b7117
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL -o /tmp/piper.tar.gz "https://github.com/rhasspy/piper/releases/download/${PIPER_VERSION}/piper_linux_x86_64.tar.gz" \
  && echo "${PIPER_SHA256}  /tmp/piper.tar.gz" | sha256sum -c - \
  && tar -xzf /tmp/piper.tar.gz -C /opt \
  && rm /tmp/piper.tar.gz /opt/piper/libtashkeel_model.ort
WORKDIR /opt/piper/voices
RUN set -e; \
  fetch() { curl -fsSL -o "$2" "https://huggingface.co/rhasspy/piper-voices/resolve/${VOICES_REV}/en/$1/$2" && echo "$3  $2" | sha256sum -c -; }; \
  fetch en_GB/cori/medium en_GB-cori-medium.onnx 1899f98e5fb8310154f3c2973f4b8a929ba7245e722b3d3a85680b833d95f10d; \
  fetch en_GB/cori/medium en_GB-cori-medium.onnx.json e262c16d7f192f69d4edd6b4ef8a5915379e67495fcc402f1ab15eeb33da3d36; \
  fetch en_GB/alan/medium en_GB-alan-medium.onnx 0a309668932205e762801f1efc2736cd4b0120329622adf62be09e56339d3330; \
  fetch en_GB/alan/medium en_GB-alan-medium.onnx.json c0f0d124e5895c00e7c03b35dcc8287f319a6998a365b182deb5c8e752ee8c1e; \
  fetch en_GB/vctk/medium en_GB-vctk-medium.onnx 4e9fc85ab9009385319fc6bae7f55577f8a2d7ee77fd9159a5500eb6531f41e6; \
  fetch en_GB/vctk/medium en_GB-vctk-medium.onnx.json 7f85e6391ed0f7f46e4abd19345929a16be931a0c9945086f96692dce2087fa8
RUN /opt/piper/piper --version

# The speech aligner's model (backend/src/align/model.ts): wav2vec2-base-960h as ONNX with its matrix
# products in 4 bits (Xenova's export on Hugging Face), pinned by revision and SHA-256.
FROM piper AS align
ARG ALIGN_REV=a19f851b3d42865797e410752b4c570c871e4825
ARG ALIGN_SHA256=337db946188e4b3d0b4a2641dc30727a4792f70aeb1750f65a20fae471f9f217
RUN mkdir -p /opt/align   && curl -fsSL -o /opt/align/wav2vec2-base-960h-q4.onnx "https://huggingface.co/Xenova/wav2vec2-base-960h/resolve/${ALIGN_REV}/onnx/model_q4.onnx"   && echo "${ALIGN_SHA256}  /opt/align/wav2vec2-base-960h-q4.onnx" | sha256sum -c -

FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*
COPY --from=piper /opt/piper /opt/piper
COPY --from=align /opt/align /opt/align

WORKDIR /app
COPY backend/package.json backend/package-lock.json ./
# ONNX Runtime (the aligner) runs on the CPU only: no CUDA download, and only its linux/x64 library kept.
RUN ONNXRUNTIME_NODE_INSTALL=skip npm ci --omit=dev \
  && find node_modules/onnxruntime-node/bin -mindepth 3 -maxdepth 3 -type d ! -path '*/linux/x64' -exec rm -rf {} + \
  && npm cache clean --force
COPY backend/migrations ./migrations
COPY backend/src ./src

ENV NODE_ENV=production PORT=8080 PIPER_BIN=/opt/piper/piper PIPER_VOICES_DIR=/opt/piper/voices ALIGN_MODEL=/opt/align/wav2vec2-base-960h-q4.onnx ORT_DISABLE_TELEMETRY=1
EXPOSE 8080
USER node
CMD ["node", "src/server.ts"]
