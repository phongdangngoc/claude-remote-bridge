#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BRIDGE="${REPO_DIR}/dist/bridge.js"
NODE_PATH="$(command -v node)"

if [[ -z "${NODE_PATH}" ]]; then
    echo "node not found in PATH. Install Node 14+ first."
    exit 1
fi

NODE_VERSION="$(node --version)"
echo "Using node: ${NODE_PATH} (${NODE_VERSION})"

if [[ ! -f "${BRIDGE}" ]]; then
    echo "Build output missing at ${BRIDGE}."
    echo "Run: npm install && npm run build"
    exit 1
fi

SD_USER_DIR="${HOME}/.config/systemd/user"
mkdir -p "${SD_USER_DIR}"

TEMPLATE="${REPO_DIR}/systemd/claude-bridge.service.template"
TARGET="${SD_USER_DIR}/claude-bridge.service"

sed \
    -e "s|__NODE_PATH__|${NODE_PATH}|g" \
    -e "s|__BRIDGE_PATH__|${BRIDGE}|g" \
    "${TEMPLATE}" > "${TARGET}"

echo "Wrote ${TARGET}"

# Enable linger so service runs after logout
if ! loginctl show-user "$USER" | grep -q "Linger=yes"; then
    echo "Enabling lingering for user $USER (sudo required)..."
    sudo loginctl enable-linger "$USER"
fi

systemctl --user daemon-reload
systemctl --user enable --now claude-bridge.service

echo
echo "Service installed. Check status:"
echo "  systemctl --user status claude-bridge.service"
echo "  journalctl --user -u claude-bridge.service -f"
