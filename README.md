# claude-remote-bridge

Control Claude Code CLI from your phone via Telegram. Approve tool calls, pick menu options, chat with Claude — from anywhere.

## How it works

`tmux pipe-pane` streams Claude TUI output → FIFO → Node daemon → Telegram. Telegram messages → `tmux send-keys` → Claude. The daemon runs as a systemd user service and activates only when you `/attach` from your phone.

Single Node 14+ process. Source is TypeScript; compiles to plain JS in `dist/` via `tsc`. Zero runtime npm dependencies — only `typescript` + `@types/node` as devDependencies.

## Platform support

The bridge depends on `tmux`, POSIX named pipes (`mkfifo`), and `systemd` for the always-on user service. That maps to:

| Platform | Status |
|---|---|
| Linux with systemd (Ubuntu, Debian, Fedora, Arch, …) | ✅ Full support — primary target |
| Windows + WSL2 (Ubuntu) | ✅ Works the same as native Linux |
| macOS | ⚠️ Daemon runs (`tmux` + `mkfifo` available), but `scripts/install.sh` does not — you'd need a `launchd` plist instead of the systemd unit |
| Linux without systemd (Alpine, container, BSD, …) | ⚠️ Code runs, but you'll need your own process supervisor |
| Windows (native, no WSL) | ❌ Unsupported — no `tmux`, no POSIX FIFO, no systemd |

## Setup (Linux, tested on Ubuntu)

```bash
# 1. Make sure Node 14+ and tmux are installed
node --version
tmux -V

# 2. Clone + build
git clone <repo-url> ~/dev/claude-remote-bridge
cd ~/dev/claude-remote-bridge
npm install        # installs typescript + @types/node
npm run build      # compiles TS → dist/

# 3. Configure (paste bot token from BotFather + your chat_id)
node dist/bridge.js init

# 4. Install systemd user service + enable linger
./scripts/install.sh

# 5. Verify
node dist/bridge.js status
journalctl --user -u claude-bridge.service -f
```

Need a bot? Talk to [@BotFather](https://t.me/BotFather) → `/newbot`, copy the token. To find your `chat_id`, message the bot then open `https://api.telegram.org/bot<TOKEN>/getUpdates`.

If you already have a credentials file (`{ "bot_token": "...", "chat_id": "..." }`) somewhere, point at it before `init`:

```bash
CLAUDE_BRIDGE_IMPORT_CREDS=/path/to/creds.json node dist/bridge.js init
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

### Forum topics / threads

The bridge supports Telegram **forum topics** (also called threads). Useful when you want to keep Claude conversations inside a single dedicated topic of a group chat instead of in DMs.

To enable, set `thread_id` in `~/.config/claude-bridge/config.json`:

```json
{
  "bot_token": "…",
  "chat_id": -1001234567890,
  "thread_id": 42,
  "allowed_chat_ids": [123456789]
}
```

`node dist/bridge.js init` will prompt you for the thread ID at setup time; leave it blank to operate against the main chat as before.

Behaviour when `thread_id` is set:

- All bot output is posted into that topic (`message_thread_id` is attached to every `sendMessage`).
- Inbound messages and button taps from other topics are silently ignored, so noise in other threads doesn't trigger commands.

To find a topic's ID, open the topic in the Telegram web client — the URL contains `/{thread_id}`. Or forward a message from the topic to [@RawDataBot](https://t.me/RawDataBot) and look for `message_thread_id`.

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
node dist/bridge.js status    # check config
# Telegram bot must not have a webhook set; daemon clears it on start

# tmux session died unexpectedly
tmux ls                       # see what's there
# Bridge auto-detaches on session death
```

## Development

```bash
# Run tests (auto-compiles first)
npm test

# Type-check only, no emit
npx tsc --noEmit

# Rebuild after edits
npm run build

# Run daemon in foreground (for dev)
node dist/bridge.js daemon

# Tail logs
node dist/bridge.js logs
```

## License

MIT — see [LICENSE](./LICENSE).
