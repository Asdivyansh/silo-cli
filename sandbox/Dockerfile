# syntax=docker/dockerfile:1
# =============================================================================
# SILO Agent Sandbox Image
# =============================================================================
# Security hardening applied at runtime by silo start:
#   --user 1001:1001         Non-root UID/GID
#   --read-only              Read-only root filesystem
#   --tmpfs /tmp             Ephemeral writable area
#   --cap-drop ALL           All Linux capabilities dropped
#   --security-opt no-new-privileges
#   --pids-limit 128         Fork-bomb protection
#   --network none           No direct network (inference proxy handles egress)
# =============================================================================

FROM python:3.12-slim AS base

LABEL org.opencontainers.image.title="SILO Agent Sandbox"
LABEL org.opencontainers.image.description="Hardened sandbox for running AI agents via the SILO platform"
LABEL org.opencontainers.image.source="https://github.com/AsDivyansh/silo"

# ---------------------------------------------------------------------------
# 1. Create a non-root user (UID/GID 1001)
# ---------------------------------------------------------------------------
RUN groupadd --gid 1001 agent && \
    useradd --uid 1001 --gid 1001 \
            --no-create-home \
            --shell /bin/sh \
            --comment "Agent sandbox user" \
            agent

# ---------------------------------------------------------------------------
# 2. Install minimal OS tooling
# ---------------------------------------------------------------------------
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl \
        git \
        ca-certificates \
        jq \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

# ---------------------------------------------------------------------------
# 3. Copy sandbox entrypoint
# ---------------------------------------------------------------------------
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# ---------------------------------------------------------------------------
# 4. Workspace mount point (populated at runtime via --volume)
# ---------------------------------------------------------------------------
RUN mkdir -p /workspace && chown 1001:1001 /workspace

# ---------------------------------------------------------------------------
# 5. Optional host mount namespace
# ---------------------------------------------------------------------------
RUN mkdir -p /host && chown 1001:1001 /host

# ---------------------------------------------------------------------------
# 6. Optional browser automation runfiles
# ---------------------------------------------------------------------------
RUN mkdir -p /browser-cache /browser-profile /browser-downloads && \
    chown 1001:1001 /browser-cache /browser-profile /browser-downloads

# ---------------------------------------------------------------------------
# 7. Agent skill definitions (read-only bind-mount at runtime)
# ---------------------------------------------------------------------------
RUN mkdir -p /skills && chown 1001:1001 /skills

# ---------------------------------------------------------------------------
# 8. SILO trace callbacks (importable by frameworks inside the container)
# ---------------------------------------------------------------------------
COPY silo_callbacks/ /usr/lib/python3/dist-packages/silo_callbacks/

# ---------------------------------------------------------------------------
# 9. Switch to non-root user
# ---------------------------------------------------------------------------
USER agent
WORKDIR /workspace

# ---------------------------------------------------------------------------
# 10. Entrypoint — keeps the container alive so `docker exec` can be used
# ---------------------------------------------------------------------------
ENTRYPOINT ["/entrypoint.sh"]
CMD ["tail", "-f", "/dev/null"]
