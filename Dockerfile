# ── Stage 1: Build mediasoup native module ────────────────────────────────
FROM node:20-slim AS mediasoup-builder

WORKDIR /build

# Install build tools for mediasoup C++ compilation
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 build-essential && \
    rm -rf /var/lib/apt/lists/*

# Install mediasoup + express (only production deps)
COPY server-package.json package.json
RUN npm install --omit=dev

# ── Stage 2: Final image ─────────────────────────────────────────────────
FROM python:3.11-slim

WORKDIR /app

# Install Node.js runtime (no build tools needed)
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl && \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    apt-get purge -y curl && apt-get autoremove -y && \
    rm -rf /var/lib/apt/lists/*

# Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy pre-built node_modules from builder stage
COPY --from=mediasoup-builder /build/node_modules ./node_modules
COPY --from=mediasoup-builder /build/package.json ./package.json

# Application code — force fresh copy every deploy (2026-04-01)
COPY server.py .
COPY media_worker.js .
COPY static/ ./static/

# Port defaults (overridden by platform env vars)
ENV PORT=10000
ENV MEDIA_WORKER_PORT=3000
ENV RTC_MIN_PORT=10000
ENV RTC_MAX_PORT=10100
EXPOSE 10000

CMD ["python", "server.py"]
