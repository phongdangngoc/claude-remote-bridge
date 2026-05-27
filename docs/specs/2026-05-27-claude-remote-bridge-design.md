# Design — Claude Remote Bridge

**Date:** 2026-05-27
**Author:** Phong Dang (phongdang.contact@gmail.com), brainstormed with Claude Code
**Target implementation:** Linux Ubuntu 22.04/24.04 LTS, 2026-05-28
**Repo:** standalone, public on GitHub.

---

## 1. Goals & scope

### 1.1 Use case

Control the Claude Code CLI from a phone via Telegram when away from the workstation:

- Two-way chat with Claude (read output, send prompts).
- Approve tool calls (Bash, Edit, Write, etc.) via inline buttons.
- Choose an option when Claude displays a multi-choice menu (AskUserQuestion).
- Continue using the CLI normally when at the workstation — the bridge only activates on `/attach`.

### 1.2 Non-goals (stated explicitly to avoid scope creep)

- No IDE-style UI.
- No macOS support.
- No reimplementation of Claude — the bridge is a dumb I/O proxy.
- No multi-user — single owner only (allowlist by `chat_id`).
- No project management or file browser from the phone (may be added later; not part of Day 1–3).

### 1.3 Decisions locked during brainstorming

| Decision | Value |
|---|---|
| Repo location | Standalone, public GitHub |
| Stack | Node 18+, zero npm dependencies (following the `tg.mjs` philosophy) |
| Medium | tmux (pipe-pane + FIFO + capture-pane + send-keys) |
| Output capture | Approach A: `pipe-pane → FIFO → Node ReadStream` (event-driven) |
| Bot + chat | Reuse the existing bot and chat from `tg.mjs` |
| Bridge lifecycle | Always-on (systemd user service) plus `/attach` / `/detach` Telegram commands |
| Claude auth | OAuth subscription via the Claude Code CLI (no API key, no token cost) |
| Primary OS | Ubuntu 22.04/24.04 LTS, sudo available |
| Full scope | Day 1 text-only · Day 2 approve buttons · Day 3 menu buttons |

---

## 2. Top-level architecture

### 2.1 Diagram

```
┌─────────────────┐        ┌───────────────────────┐
│  Phone          │ ──▶    │ Telegram Bot API      │
│  (Telegram app) │ ◀──    │ api.telegram.org      │
└─────────────────┘        └──────────┬────────────┘
                                      │ getUpdates (long-poll 30s)
                                      │ sendMessage / editMessageText / answerCallbackQuery
                            ┌─────────▼──────────┐
                            │  bridge daemon     │ ← single Node process
                            │  (Node 18+, 0 deps)│
                            └───┬────────┬───────┘
              FIFO read         │        │  tmux send-keys / capture-pane / pipe-pane
                                ▼        ▼
                            ┌───────────────────┐
                            │  tmux server      │
                            │  session: <name>  │
                            └──────────┬────────┘
                                       │
                            ┌──────────▼────────┐
                            │  claude (CLI)     │
                            └───────────────────┘
```

### 2.2 Five components

1. **bridge daemon** — a single Node process running 24/7 (systemd user service). Contains: the Telegram long-poll loop, FIFO reader, pane parser, tmux command dispatcher, and state manager. Stateless with regard to Claude context — pure bytes in, bytes out.

2. **tmux session(s)** — each Claude Code instance runs in a named tmux session. The user starts a session manually or via `bridge new <name>`. The bridge attaches to one session at a time (MVP).

3. **FIFO per attached session** — `/run/user/$UID/claude-bridge/<session>.fifo`. Created on `/attach`, removed on `/detach`.

4. **State file** — `~/.config/claude-bridge/state.json`. Persists `attached_session`, `last_telegram_update_id`, and `outbound_message_id`. Restored when the daemon restarts.

5. **Config file** — `~/.config/claude-bridge/config.json`. Contains `bot_token`, `chat_id`, `allowed_chat_ids`, and tunable parameters.

### 2.3 Design principles

- **Dumb proxy.** The bridge does not understand Claude. The parser is a separate layer that is easy to swap when Claude changes its UI.
- **Single process.** All I/O shares one event loop. tmux commands are invoked via short-lived `child_process.spawn` calls.
- **Zero dependencies.** Only `https`, `fs`, `child_process`, `readline`, `crypto`, `os`, `path`.
- **Reuse `tg.mjs` patterns** — `loadCredentials()` and `sendMessage()` can be imported instead of rewritten.

---

## 3. Telegram command surface

### 3.1 Commands

| Command | Action | Phase |
|---|---|---|
| `/help` | List commands and current state | Day 1 |
| `/list` | Run `tmux ls`, display all sessions and their status (attached/idle) | Day 1 |
| `/attach <name>` | Start mirroring that session to Telegram; accept input | Day 1 |
| `/detach` | Stop mirroring; the bridge goes silent. The tmux session remains alive. | Day 1 |
| `/status` | Which session is attached? Bridge uptime? Last activity? | Day 1 |
| `/new <name>` | Run `tmux new -d -s <name> 'claude'`, then auto `/attach` | Day 2 |
| `/kill <name>` | Kill a session (two-step confirmation via inline button) | Day 3 |
| `/raw <text>` | Send literal text without an Enter (for pasting, escape sequences) | Day 3 |

### 3.2 Plain text message (no leading `/`)

- **Attached** → `tmux send-keys -l -t <session> "<text>"` (literal), then `tmux send-keys -t <session> Enter`.
- **Detached** → the bot replies "not attached; use /list to see sessions".

### 3.3 Inline buttons

```
Approve prompt:  [Yes (Enter)]  [Always (2+Enter)]  [No (Esc)]
Multi-choice:    [A. Opt 1]     [B. Opt 2]          [C. Opt 3]
Raw key fallback:[↩ Enter]      [⎋ Esc]             [↑] [↓]
```

Each button has `callback_data` encoding the key sequence to send. The bridge receives the `callback_query` and dispatches `tmux send-keys`.

### 3.4 Reply-to-message

Long-press → Reply in Telegram. The bridge recognises this as a reply to a specific prompt rather than a new command. Useful when multiple streams interleave.

### 3.5 Authorization

- Every update (message and callback_query) is checked against `from.id ∈ allowed_chat_ids` from the config.
- Updates from non-allowlisted users are silently ignored (no reply, no payload logged).
- `allowed_chat_ids` defaults to `[chat_id]` from the initial config. Additional IDs can be added later by editing the config and sending SIGHUP to reload.

---

## 4. Output streaming & prompt detection

### 4.1 Two parallel paths

- **FIFO stream** → "live mirror": output token-by-token, editing a Telegram message in place.
- **`capture-pane` snapshot** → "state inspection": run AFTER each quiet period, parsed to detect prompts.

The chosen pattern: FIFO for realtime, snapshots for analysis. Because the FIFO is a byte stream interleaved with ANSI escapes (cursor positioning, clears), it is hard to parse directly. `capture-pane` returns plain text after tmux has rendered, which is much easier for the parser.

### 4.2 Pipeline

```
FIFO bytes ─▶ ringBuffer ─┬─▶ ANSI-strip + debouncer ──▶ Telegram message stream
                          │       (edit while streaming, finalize on silence)
                          │
                          └─▶ silence-detector (800ms) ──▶ tmux capture-pane
                                                           ──▶ parser ──▶ detectPrompt()
                                                                          ├─ approve → inline buttons
                                                                          ├─ menu    → inline buttons
                                                                          └─ free    → nothing extra
```

### 4.3 Streaming UX (edit-in-place)

- The first chunk after silence → `sendMessage`; the returned `message_id` is stored.
- Subsequent chunks within 1.5s → accumulate in a buffer; call `editMessageText` every 1.5s (Telegram rate limit is roughly 1 edit per second per message).
- After 800ms of silence → finalize: a last edit is sent and no further edits are issued. The next chunk starts a new message.
- Telegram message length cap is 4096 characters → when exceeded, finalize and split into a new message.

### 4.4 ANSI strip

```js
const ANSI_CSI   = /\x1b\[[0-9;?]*[a-zA-Z]/g       // colour, cursor move
const ANSI_OSC   = /\x1b\][^\x07]*\x07/g            // title set
const ANSI_2BYTE = /\x1b[78MD]/g                    // save/restore, scroll
text.replace(ANSI_CSI, '').replace(ANSI_OSC, '').replace(ANSI_2BYTE, '')
```

### 4.5 Prompt detection

```js
function detectPrompt(plainText) {
  const last20 = plainText.split('\n').slice(-20).join('\n')

  // 1. Approve dialog
  if (/Do you want to proceed/i.test(last20) && /❯\s*1\./.test(last20)) {
    return { type: 'approve', options: extractNumbered(last20) }
  }

  // 2. Multi-choice menu (AskUserQuestion)
  if (/❯\s+\S/.test(last20) && /^\s+\S/m.test(last20)) {
    return { type: 'menu', options: extractMenuOptions(last20) }
  }

  // 3. Free-text prompt fallback
  return { type: 'free' }
}
```

### 4.6 Fallback when the parser misses

Every snapshot includes the last 20 lines of text in the Telegram message inside a code block. If the parser misses, the user can read the raw output and reply with raw text (`1`, `↓`, etc.). Buttons are a convenience, not a requirement.

### 4.7 Tunable parameters

```json
{
  "silence_ms": 800,
  "edit_throttle_ms": 1500,
  "max_message_chars": 4000,
  "snapshot_lines": 50,
  "cursor_chars": ["❯", "►", ">"]
}
```

### 4.8 Output edge cases

- Bridge restart while attached → read `state.json`, reattach the FIFO; do not restream older output (stream from the restart point onward).
- User sends text while Claude is streaming → bridge queues the input, waits for quiet, then send-keys. This avoids interleaving that would confuse the parser.
- tmux session dies while attached → the bridge detects this (`tmux has-session` fails), auto-detaches, and notifies the user.

---

## 5. Daemon process model and state

### 5.1 Process model

A single Node process with an async event loop. No child Node processes are spawned. tmux is invoked via short-lived `child_process.spawn` calls (fire-and-forget or await on stdout).

### 5.2 Boot sequence

```
main()
 ├─ loadConfig()       ~/.config/claude-bridge/config.json
 ├─ loadState()        ~/.config/claude-bridge/state.json
 ├─ deleteWebhook()    defensive (the Telegram bot may have had a webhook set previously)
 ├─ startTelegramLoop()    long-poll getUpdates, never returns
 ├─ if state.attached_session:
 │     reattach(state.attached_session)  restore FIFO + pipe-pane
 └─ install signal handlers (SIGTERM → detachAll + saveState + exit)
                          (SIGHUP  → reloadConfig)
```

### 5.3 Internal actors (sharing one event loop)

```
[Telegram poller]  ──▶  [Command dispatcher]  ──▶  [Tmux controller]
                                                       │
[FIFO reader]  ──▶  [Streamer + parser]  ─────────────┘
       (per attached session, only 1 in MVP)
                                                       │
                                                       ▼
                                              [Telegram sender + edit throttle]
```

### 5.4 Shared in-memory state

```js
const bridgeState = {
  attached: null,            // { session, fifoPath, fifoStream, parser } | null
  outboundMessageId: null,   // current Telegram message_id being edited
  outboundBuffer: '',
  lastTelegramUpdateId: 0,
  pendingInput: [],          // input queued while Claude is streaming
  startedAt: Date.now(),
  lastFifoByteAt: 0,
  errorsLastHour: 0,
}
```

### 5.5 State file format

```json
{
  "attached_session": "claude-myproject",
  "last_update_id": 845392,
  "outbound_message_id": null,
  "saved_at": "2026-05-27T14:30:00Z"
}
```

- Saved on SIGTERM and after each successful `/attach` or `/detach`.
- Loaded at startup. If `attached_session` is non-null AND `tmux has-session -t <name>` succeeds → reattach. If the session is dead → clear state and send a Telegram notification.
- `last_update_id` keeps the bridge idempotent — a restart does not re-process old commands.

### 5.6 Crash recovery

- Telegram `update_id` offset prevents replay.
- Stale FIFO from a previous run: unlink, then `mkfifo` again.
- Orphan `pipe-pane` on tmux: call `tmux pipe-pane -t <session>` with no command before establishing a new pipe.
- Outbound Telegram message left mid-stream: state writes `outbound_message_id=null` on clean shutdown → restart begins a new message (avoiding the "message older than 48h" edit failure).

### 5.7 systemd user service

`~/.config/systemd/user/claude-bridge.service`:

```ini
[Unit]
Description=Claude Code Telegram Bridge
After=default.target

[Service]
Type=simple
ExecStart=/usr/bin/node %h/dev/claude-remote-bridge/bridge.mjs daemon
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
```

- Enable: `systemctl --user enable --now claude-bridge.service`
- Logs: `journalctl --user -u claude-bridge.service -f`
- Linger: `sudo loginctl enable-linger $USER` (one-time) so the service runs after logout.

### 5.8 CLI commands of `bridge.mjs`

```
bridge.mjs daemon           foreground; used by systemd or for development
bridge.mjs init             interactive setup (bot token, chat_id, allowlist)
bridge.mjs install          write + enable the systemd unit; enable linger
bridge.mjs status           show daemon status and attached session
bridge.mjs logs             tail journalctl
bridge.mjs new <name>       tmux new -d -s <name> 'claude'
bridge.mjs attach <name>    CLI version of /attach (local debugging)
```

---

## 6. Repo structure and deployment

### 6.1 Layout

```
claude-remote-bridge/
├── README.md
├── package.json              name, bin, engines.node >=18; dependencies: {}
├── .gitignore                node_modules, .config/, *.log
├── bridge.mjs                main entry — CLI dispatcher
├── lib/
│   ├── config.mjs            load/save config and state, defaults
│   ├── telegram.mjs          sendMessage, editMessageText, getUpdates, answerCallbackQuery
│   ├── tmux.mjs              spawn wrappers: hasSession, ls, send-keys, capture-pane, pipe-pane, new
│   ├── fifo.mjs              mkfifo, open read stream, cleanup
│   ├── parser.mjs            ANSI strip, detectPrompt, extractOptions
│   ├── streamer.mjs          debounce + edit throttle + message split
│   ├── dispatcher.mjs        command and callback handlers
│   └── daemon.mjs            main loop wiring
├── scripts/
│   ├── install.sh            write systemd unit, enable linger, start service
│   └── uninstall.sh
└── systemd/
    └── claude-bridge.service.template
```

### 6.2 Install flow (on the target machine)

```bash
# 1. Clone
mkdir -p ~/dev && cd ~/dev
git clone git@github.com:<your-handle>/claude-remote-bridge.git
cd claude-remote-bridge

# 2. Init: bot token, chat_id, allowlist
node bridge.mjs init

# 3. Install systemd unit
./scripts/install.sh

# 4. Verify
node bridge.mjs status
journalctl --user -u claude-bridge.service -f
```

### 6.3 Creating a Claude session (separate from the bridge)

```bash
# Option 1: manual
tmux new -d -s claude-myproject -c ~/projects/myproject 'claude'

# Option 2: convenience CLI
bridge.mjs new claude-myproject -d ~/projects/myproject

# Option 3: alias in .bashrc (recommended)
alias claude-start='tmux new -d -s claude-$(basename $(pwd)) "claude" && tmux attach -t claude-$(basename $(pwd))'
```

Then: `tmux attach -t claude-myproject` when at the workstation. When away → on Telegram, `/list` → `/attach claude-myproject`.

### 6.4 Config and credentials

```
~/.config/claude-bridge/
├── config.json       bot_token, chat_id, allowed_chat_ids, tunables. Permission 0600.
└── state.json        runtime state (auto-managed)
```

`bridge.mjs init` offers to import from `~/.config/claude-bridge-tg/credentials.json` or `.claude/tools/telegram/.credentials.json` if either exists (one-time prompt).

### 6.5 Update workflow

```bash
cd ~/dev/claude-remote-bridge
git pull
systemctl --user restart claude-bridge.service
```

Zero dependencies → no `npm install` needed.

### 6.6 Node version requirement

Ubuntu apt ships an older Node. Install Node ≥ 18 via NodeSource:

```bash
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt install -y nodejs
```

The systemd `ExecStart=/usr/bin/node` works with a NodeSource install.

---

## 7. Phasing

### 7.1 Day 1 — "Text-only chat works" (~6–8h)

**Goal:** Step out for coffee, `/attach` a session, and chat with Claude over Telegram. Approve/menu replies use raw text (`1`, `2`, `y`).

**Tasks (in order):**

1. `git init` + `package.json` + `.gitignore`; push to GitHub.
2. `lib/config.mjs` — load/save config and state. Copy the `loadCredentials()` pattern from `tg.mjs` (do not import — `tg.mjs` lives in a different repo; just port the ~30 lines of zero-dep loader logic).
3. `lib/telegram.mjs` — `sendMessage`, `editMessageText`, `getUpdates` long-poll, `answerCallbackQuery`. Zero deps, raw `https`.
4. `lib/tmux.mjs` — wrappers for `hasSession`, `listSessions`, `sendKeys`, `capturePane`, `pipePane`, `newSession`.
5. `lib/fifo.mjs` — `mkfifo`, `openReadStream`, `cleanup`.
6. `lib/parser.mjs` — ANSI strip only (no prompt detection yet).
7. `lib/streamer.mjs` — 800ms debounce + 1.5s edit throttle + split at 4000 chars.
8. `lib/dispatcher.mjs` — `/help` `/list` `/attach` `/detach` `/status` plus plain-text input.
9. `lib/daemon.mjs` — wiring, signal handlers, state saving.
10. `bridge.mjs` — CLI dispatcher: `daemon | init | status | new | logs | attach`.
11. `scripts/install.sh` — systemd unit + linger.
12. **Manual test:** start a tmux `claude` session, `/attach`, type from the phone, see Claude reply, send `1` to approve.

**Day 1 must ship:**
- One session attach/detach works.
- Output mirrors live (edit throttle stable).
- Input from Telegram reaches Claude via send-keys.
- Bridge auto-reattaches after `systemctl restart`.
- Authorization (`allowed_chat_ids`) blocks unknown users.

**Deferred out of Day 1:**
- Multi-session UX polish (focus on one session).
- Approve/menu button parsing (raw text is fine).
- `/new`, `/kill`, `/raw` commands.

### 7.2 Day 2 — Approve buttons + `/new` (~3–4h)

1. `parser.detectPrompt()` — match approve-prompt patterns.
2. `streamer` — after a message is finalized, if the snapshot indicates an approve prompt, send a second message with a `reply_markup` inline keyboard `[Yes][Always][No]`.
3. Telegram `callback_query` handler → decode `callback_data` → `tmux send-keys`.
4. `answerCallbackQuery` to dismiss the loading spinner on the phone.
5. Edit the original message after approval to show the result (e.g. "Approved: Yes").
6. Add the `/new <name>` Telegram command to the dispatcher (the CLI `bridge.mjs new` already exists from Day 1; only the Telegram wrapper is new).

**Test:** trigger a Claude approve dialog and verify the button on the phone works.

### 7.3 Day 3 — Menu parsing and polish (~3–4h)

1. `parser.detectPrompt()` — handle the `menu` case; extract options from the `❯ X` pattern.
2. Build a dynamic inline keyboard from the options (max 8 buttons; split into rows of 2).
3. `callback_data` encodes "press Down N times then Enter" (`menu:2` → 2 Downs + Enter).
4. Implement `/new <name>`, `/kill <name>` (two-step confirm), `/raw <text>`.
5. Multi-session: `/list` shows an attached marker and allows switching attach targets.
6. Polish the Telegram message format: monospace code blocks, prompt highlighting.

**Test:** trigger an AskUserQuestion with 3–4 options, verify buttons render and pressing one selects the right choice.

### 7.4 Cut-line if only 4 hours are available the next day

Day 1 tasks 1–9 (skip 10–11: install script and systemd). Run `node bridge.mjs daemon` inside a dedicated tmux pane. Gracefulness is lost, but it works. systemd setup can wait for the following evening.

### 7.5 After Day 3 (week 2+)

- Windows/WSL2 setup (port the install script; WSL lacks systemd → `nohup` or `systemd-genie`).
- File upload: send an image from the phone → bridge saves it to `/tmp` → `tmux send-keys` pastes the path into Claude.
- `/sessions all` monitoring without requiring attachment.
- Nicer Markdown formatting for code blocks (detect ``` in output).
- Web debug dashboard.

---

## 8. Error handling and failure modes

### 8.1 Telegram API

| Error | Handling |
|---|---|
| Network timeout/refused | Exponential backoff 1→2→4→…→60s. Warn log. No notification (avoid loops). |
| 429 rate limit | Read `retry_after` and sleep accordingly. |
| 400 "message is not modified" | Skip the edit; no retry. |
| 400 "message too old to edit" (>48h) | Reset `outboundMessageId=null` and send a new message. |
| 401 invalid token | Crash with exit code 78 (EX_CONFIG). systemd stops restarting after 5 consecutive failures. |
| Webhook conflict | Defensive `deleteWebhook` at startup. |

### 8.2 tmux

| Situation | Handling |
|---|---|
| `/attach` target session does not exist | Reply with the session list and a `/new` hint. |
| Session dies while attached | FIFO EOF + `has-session` failure → auto-detach + notify. |
| `pipe-pane` fails because the pane already has a pipe | Clear it with `tmux pipe-pane -t <session>` (no command) first. |
| `send-keys` against a freshly-dead session | Catch the error, notify, auto-detach. |
| tmux server not running | `/attach` fails → "tmux server not running". |

### 8.3 FIFO

| Situation | Handling |
|---|---|
| FIFO survives from a previous run | Unlink and `mkfifo` again. |
| Permission denied on `/run/user/$UID/` | Fall back to `/tmp/claude-bridge-$UID/`. |
| Reader dies while tmux is writing | SIGPIPE on `cat` is fine — restarting the bridge clears the old pipe. |
| UTF-8 split across multi-byte boundary | Buffer raw bytes and decode on flush. |

### 8.4 Parser

| Situation | Handling |
|---|---|
| Malformed ANSI escape | Best-effort strip; residue is acceptable. |
| Output flood (>1 MB/s) | The streamer drops intermediates and keeps the last 4000 chars. Emit a `[N kB truncated]` warning. |
| Prompt-detect false positive | The fallback always includes raw text, so the user can ignore the button if it is wrong. |
| Prompt-detect miss | The user replies with raw text; send-keys works as usual. |

### 8.5 Bridge process

| Situation | Handling |
|---|---|
| Unhandled exception | `process.on('uncaughtException')` → log → save state → exit 1 → systemd restart. |
| Memory leak (unbounded buffer) | Hard cap `outboundBuffer` at 8000 chars, head-drop. |
| `/detach` racing with a flush | Detach sets `attached=null`; the streamer checks before each edit. |
| SIGTERM racing with mid-pipe-pane | The signal handler waits up to 2s for in-flight tmux commands before exiting. |
| Corrupt `state.json` | Catch the parse error, treat the state as empty, log a warning. |

### 8.6 Security

| Vector | Mitigation |
|---|---|
| Unknown user chats | `from.id ∉ allowed_chat_ids` → silently ignore. |
| Token leak via git | `.gitignore` blocks `config.json` and `state.json`. Init writes to an absolute path. |
| `send-keys` injection | `-l` flag is used for user text. Special keys (Enter, Down, Esc) are bridge constants. |
| Replay after a crash | `last_update_id` offset in getUpdates. |
| Allowlist edit race | SIGHUP reload (`systemctl --user reload`). |

### 8.7 Observability

- Logs go to `console.error` → systemd journal, viewed via `journalctl --user -u claude-bridge`.
- Format: `[level] [actor] message` (e.g. `[info] [telegram] long-poll cycle ok`).
- Levels: `info`, `warn`, `error`. `debug` is gated by the `DEBUG=1` env var.
- `/status` metrics: uptime, `last_telegram_poll_at`, `last_fifo_byte_at`, `errors_last_hour`.

---

## 9. Open questions / future work

- **Windows/WSL2 path:** to be ported when time permits. WSL lacks systemd → needs a `nohup` fallback or `systemd-genie`. Deferred to week 2+.
- **Multi-session UX:** currently only one session can be attached at a time. If multiple are needed, `/list` could display per-session status, and Telegram threads/topics could map to sessions.
- **File upload:** send an image from the phone → bridge saves it → paste it into Claude. Useful for debugging via screenshot.
- **Reload config without restart:** SIGHUP — implement during Day 2/3 if time permits.
- **Bridge web dashboard:** debug-only, localhost. Deferred.

---

## 10. Patterns to verify before coding

Before writing code, manually verify on Linux:

1. `mkfifo /tmp/test.fifo` → tmux pipes into it → Node `fs.createReadStream` can read.
2. `tmux send-keys -l -t <session> "hello"` shows "hello" in the Claude TUI.
3. `tmux capture-pane -p -t <session>` — does the output contain ANSI escapes or rendered text? (Add `-e` to keep escapes.)
4. Telegram bot `getUpdates` with 30s long-poll — no errors, no spam.
5. `systemctl --user` plus linger work on the target Ubuntu LTS box.

If (1)–(5) all work → implement per the plan. If (3) differs from expectations (e.g. capture-pane returns raw ANSI) → adjust the parser.

---

**End of design doc.**
