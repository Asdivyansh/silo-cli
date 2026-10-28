#!/usr/bin/env bash
# =============================================================================
# SILO — Uninstall Script
# =============================================================================
set -euo pipefail

INSTALL_DIR="/usr/local/lib/silo"
BIN_LINK="/usr/local/bin/silo"

RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; RESET='\033[0m'
info()    { echo -e "${CYAN}  ℹ${RESET}  $*"; }
success() { echo -e "${GREEN}  ✔${RESET}  $*"; }
warn()    { echo -e "${RED}  ⚠${RESET}  $*"; }

# ── Stop running sandbox if any ───────────────────────────────────────────────
if command -v silo &>/dev/null 2>&1; then
  info "Stopping any running sandbox…"
  silo stop 2>/dev/null || true
fi

# ── Remove installed files ────────────────────────────────────────────────────
if [ -L "$BIN_LINK" ] || [ -f "$BIN_LINK" ]; then
  rm -f "$BIN_LINK"
  success "Removed ${BIN_LINK}"
else
  warn "${BIN_LINK} not found — skipping"
fi

if [ -d "$INSTALL_DIR" ]; then
  rm -rf "$INSTALL_DIR"
  success "Removed ${INSTALL_DIR}"
else
  warn "${INSTALL_DIR} not found — skipping"
fi

# ── Offer to remove config ────────────────────────────────────────────────────
CONFIG_DIR="${HOME}/Library/Preferences/cli-silo-nodejs"  # macOS default
if [ ! -d "$CONFIG_DIR" ]; then
  CONFIG_DIR="${HOME}/.config/cli-silo-nodejs"            # Linux default
fi

if [ -d "$CONFIG_DIR" ]; then
  echo ""
  read -r -p "  Remove configuration at ${CONFIG_DIR}? [y/N] " confirm
  if [[ "$confirm" =~ ^[Yy]$ ]]; then
    rm -rf "$CONFIG_DIR"
    success "Config removed"
  else
    info "Config kept at ${CONFIG_DIR}"
  fi
fi

echo ""
echo -e "${GREEN}  SILO uninstalled successfully.${RESET}"
echo ""
