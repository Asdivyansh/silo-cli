#!/usr/bin/env bash
# =============================================================================
# SILO — Install Script
# =============================================================================
# Usage: ./install.sh          (from a local clone)
#    or: ./install.sh --dev    (dev mode: symlink instead of copy, no build)
# =============================================================================
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="/usr/local/lib/silo"
BIN_LINK="/usr/local/bin/silo"
DEV_MODE=false

# ── Parse flags ───────────────────────────────────────────────────────────────
for arg in "$@"; do
  case "$arg" in
    --dev) DEV_MODE=true ;;
    *) echo "Unknown flag: $arg" >&2; exit 1 ;;
  esac
done

# ── Colours ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; RESET='\033[0m'
info()    { echo -e "${CYAN}  ℹ${RESET}  $*"; }
success() { echo -e "${GREEN}  ✔${RESET}  $*"; }
error()   { echo -e "${RED}  ✖${RESET}  $*" >&2; }

# ── Prerequisites ─────────────────────────────────────────────────────────────
info "Checking prerequisites…"

if ! command -v node &>/dev/null; then
  error "Node.js is not installed. Please install Node.js 18+ from https://nodejs.org"
  exit 1
fi

NODE_MAJOR=$(node -e 'process.stdout.write(process.versions.node.split(".")[0])')
if [ "$NODE_MAJOR" -lt 18 ]; then
  error "Node.js 18+ is required (found $(node --version))"
  exit 1
fi
success "Node.js $(node --version)"

if ! command -v npm &>/dev/null; then
  error "npm is not installed."
  exit 1
fi
success "npm $(npm --version)"

if ! command -v docker &>/dev/null; then
  error "Docker is not installed. Install Docker Desktop from https://www.docker.com/products/docker-desktop/"
  exit 1
fi
success "Docker $(docker --version | awk '{print $3}' | tr -d ',')"

# ── Install dependencies ───────────────────────────────────────────────────────
info "Installing npm dependencies…"
cd "$REPO_DIR"
npm install --silent
success "Dependencies installed"

# ── Build ─────────────────────────────────────────────────────────────────────
if [ "$DEV_MODE" = false ]; then
  info "Building TypeScript bundle…"
  npm run build --silent
  success "Build complete → ${REPO_DIR}/dist/cli.js"
fi

# ── Install globally ──────────────────────────────────────────────────────────
info "Installing to ${INSTALL_DIR}…"

if [ -d "$INSTALL_DIR" ]; then
  info "Removing previous installation at ${INSTALL_DIR}"
  rm -rf "$INSTALL_DIR"
fi

mkdir -p "$INSTALL_DIR"

if [ "$DEV_MODE" = true ]; then
  # In dev mode just symlink the source directory
  ln -sf "$REPO_DIR" "$INSTALL_DIR/source"
  ENTRY="${REPO_DIR}/src/cli.ts"
  RUNNER="npx tsx"
else
  for asset in dist package.json node_modules sandbox policies docs README.md LICENSE CONTRIBUTING.md SECURITY.md uninstall.sh; do
    if [ -e "$asset" ]; then
      cp -R "$asset" "$INSTALL_DIR/"
    fi
  done
  ENTRY="${INSTALL_DIR}/dist/cli.js"
  RUNNER="node"
fi

# ── Write the wrapper script ───────────────────────────────────────────────────
if [ -L "$BIN_LINK" ] || [ -f "$BIN_LINK" ]; then
  rm -f "$BIN_LINK"
fi

cat > "$BIN_LINK" <<WRAPPER
#!/usr/bin/env bash
exec ${RUNNER} "${ENTRY}" "\$@"
WRAPPER
chmod +x "$BIN_LINK"
success "Symlink created: ${BIN_LINK} → ${ENTRY}"

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}  SILO installed successfully!${RESET}"
echo ""
echo "  Get started:"
echo "    silo onboard    — configure your LLM provider and sandbox"
echo "    silo --help     — show all commands"
echo ""
