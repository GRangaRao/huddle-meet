# ── P2P mode — no mediasoup, just Python signaling server ─────────────────
FROM python:3.11-slim

WORKDIR /app

# Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Application code
COPY server.py .
COPY static/ ./static/

# Port defaults (overridden by platform env vars)
ENV PORT=10000
EXPOSE 10000

CMD ["python", "server.py"]
