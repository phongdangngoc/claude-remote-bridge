#!/usr/bin/env bash
set -euo pipefail

TARGET="${HOME}/.config/systemd/user/claude-bridge.service"

if systemctl --user is-active --quiet claude-bridge.service; then
    systemctl --user stop claude-bridge.service
fi
systemctl --user disable claude-bridge.service 2>/dev/null || true
rm -f "${TARGET}"
systemctl --user daemon-reload

echo "Uninstalled. Config + state under ~/.config/claude-bridge/ kept."
echo "  rm -rf ~/.config/claude-bridge   # to wipe credentials too"
