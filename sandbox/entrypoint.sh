#!/bin/sh
# =============================================================================
# SILO Sandbox Entrypoint
# =============================================================================
# This script runs as the first process inside the container (PID 1).
# It performs light health checks and then executes the CMD passed by Docker.
# =============================================================================
set -e

# Verify we are NOT running as root
if [ "$(id -u)" = "0" ]; then
  echo "ERROR: Refusing to run as root inside the sandbox." >&2
  exit 1
fi

# ── Welcome banner ──────────────────────────────────────────────────────────
echo ""
echo "  ╭──────────────────────────────────────────────╮"
echo "  │  ◆  SILO — Secure Agent Sandbox              │"
echo "  ╰──────────────────────────────────────────────╯"
echo ""
echo "  User:       $(whoami) (UID=$(id -u))"
echo "  Workspace:  ${PWD}"

# Show framework info if active
if [ -n "${SILO_FRAMEWORK}" ]; then
  echo "  Framework:  ${SILO_FRAMEWORK}"
fi

# Show proxy status
if [ -n "${http_proxy}" ]; then
  echo "  Proxy:      ${http_proxy}"
  echo "  Network:    All egress routed through SILO proxy"
else
  echo "  Proxy:      not configured"
fi

echo ""
echo "  ┌─ Quick Reference ──────────────────────────┐"
echo "  │  pip install <pkg>   Install Python packages│"
echo "  │  git clone <url>     Clone repositories     │"
echo "  │  python3 script.py   Run Python scripts     │"
echo "  │  curl llm.gateway    Test LLM connectivity  │"
echo "  │  exit                Leave sandbox          │"
echo "  └─────────────────────────────────────────────┘"
echo ""

# Load any skill init scripts from /skills/*.sh
if [ -d /skills ]; then
  for skill in /skills/*.sh; do
    [ -f "$skill" ] || continue
    echo "  Loading skill: $(basename "$skill")"
    # shellcheck disable=SC1090
    . "$skill"
  done
fi

echo "  Sandbox ready. Type commands below."
echo ""
exec "$@"
