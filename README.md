# claude-remote-bridge

Control Claude Code CLI from your phone via Telegram. Approve tool calls, pick menu options, chat with Claude — from anywhere.

## How it works

`tmux pipe-pane` streams Claude TUI output → FIFO → Node daemon → Telegram. Telegram messages → `tmux send-keys` → Claude. The daemon runs as a systemd user service and activates only when you `/attach` from your phone.

Single Node 14+ process, zero npm deps.

## Setup (Linux, tested on Ubuntu)

```bash
# 1. Make sure Node 14+ and tmux are installed
node --version
tmux -V

# 2. Clone
git clone <repo-url> ~/dev/claude-remote-bridge
cd ~/dev/claude-remote-bridge

# 3. Configure (paste bot token from BotFather + your chat_id)
node bridge.mjs init

# 4. Install systemd user service + enable linger
./scripts/install.sh

# 5. Verify
node bridge.mjs status
journalctl --user -u claude-bridge.service -f
```

Need a bot? Talk to [@BotFather](https://t.me/BotFather) → `/newbot`, copy the token. To find your `chat_id`, message the bot then open `https://api.telegram.org/bot<TOKEN>/getUpdates`.

If you already have a credentials file (`{ "bot_token": "...", "chat_id": "..." }`) somewhere, point at it before `init`:

```bash
CLAUDE_BRIDGE_IMPORT_CREDS=/path/to/creds.json node bridge.mjs init
```

## Daily use

```bash
# Start a Claude session in tmux
tmux new -d -s claude-myproject -c ~/projects/myproject 'claude'

# Attach locally if you want
tmux attach -t claude-myproject
```

From your phone, message the bot:

| Command | What it does |
|---|---|
| `/help` | Show all commands |
| `/list` | List all tmux sessions |
| `/attach <name>` | Start mirroring this session |
| `/detach` | Stop mirroring |
| `/status` | Bridge state |
| `/new <name>` | Create + attach a new session |
| `/kill <name>` | Kill a session (2-step confirm) |
| `/raw <text>` | Send text without Enter (paste) |

When attached, plain text messages → `send-keys` to Claude. Inline buttons appear when an approve dialog or menu is detected.

## Architecture

```
Phone (Telegram) ↔ Bot API ↔ bridge daemon (Node) ↔ tmux ↔ claude (CLI)
```

## Troubleshooting

```bash
# Service not starting
systemctl --user status claude-bridge.service
journalctl --user -u claude-bridge.service -e

# Telegram not responding
node bridge.mjs status        # check config
# Telegram bot must not have a webhook set; daemon clears it on start

# tmux session died unexpectedly
tmux ls                       # see what's there
# Bridge auto-detaches on session death
```

## Development

```bash
# Run tests
npm test

# Run daemon in foreground (for dev)
node bridge.mjs daemon

# Tail logs
node bridge.mjs logs
```

## License

MIT
