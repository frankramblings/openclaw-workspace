# OpenClaw Workspace — Docker image
#
# Multi-stage: a builder stage installs Python deps + builds the frontend;
# the runtime stage copies only what's needed.
#
# Optional integration tabs (Email, Calendar) require extra tooling that is NOT
# baked in here to keep the image lean:
#   - Email tab:    himalaya binary (e.g. mount it or install in a derived image)
#   - Calendar tab: may need Google OAuth tooling
#   - Documents:    pandoc (for export)
# Chat works out of the box against any OpenClaw gateway.

# ── Builder stage ────────────────────────────────────────────────────────────
FROM python:3.11-slim AS builder

# OS packages needed by the frontend build scripts
RUN apt-get update && apt-get install -y --no-install-recommends \
        rsync \
        bash \
        sed \
        findutils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python deps (cache-friendly: copy requirements before source)
COPY backend/requirements.txt ./backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt uvicorn[standard]

# Copy the full repo (respects .dockerignore)
COPY . .

# Build the frontend with the default agent name "Claw" baked in.
# Users who want a different name can override WORKSPACE_AGENT_NAME at runtime
# and the entrypoint will re-bake it (see deploy/docker-entrypoint.sh).
RUN bash scripts/setup.sh --name Claw --yes --skip-connect

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        rsync \
        bash \
        sed \
        findutils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy installed Python packages from builder
COPY --from=builder /usr/local/lib/python3.11 /usr/local/lib/python3.11
COPY --from=builder /usr/local/bin/uvicorn /usr/local/bin/uvicorn

# Copy application source + built frontend
COPY --from=builder /app /app

# Persist per-install state here (branding, session store, etc.)
VOLUME ["/app/.data"]

EXPOSE 8800

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8800/api/health')" || exit 1

ENTRYPOINT ["bash", "deploy/docker-entrypoint.sh"]
