# Claude Remote Bridge — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Author:** Phong Dang

**Goal:** Telegram-driven remote bridge for the Claude Code CLI. Attach a tmux session from your phone with `/attach`, then chat, approve, and select menu items in Claude from anywhere.

**Architecture:** Single Node 14+ daemon (zero dependencies). `tmux pipe-pane → FIFO → fs.ReadStream` for live output mirroring. `tmux capture-pane` snapshots for prompt detection. Telegram `getUpdates` long-poll for input. Always-on as a systemd user service, activated by the `/attach` Telegram command.

**Tech Stack:** Node 14+ ESM, raw `https`, `fs`, `child_process`. Zero npm dependencies. Ubuntu 22.04+ LTS (production), Windows (development of pure-logic code only). systemd user service plus linger.

**Spec:** `docs/specs/2026-05-27-claude-remote-bridge-design.md`

**Execution split:**
- **Phase 1 — development (any OS, code-only):** Tasks 1-15 — full codebase, unit tests for parser and streamer, push to GitHub. No Linux dependency required.
- **Phase 2 — Linux deployment:** Tasks 16-20 — clone, verify environment, install systemd service, manual end-to-end testing, fix any Linux-specific bugs.

**Cut-line if Phase 1 runs short:** Stop after Task 11 (CLI). Tasks 12-14 (systemd, install script, README) can move into Phase 2. Task 15 (push to GitHub) must complete before ending Phase 1.

---

## File structure

```
claude-remote-bridge/
├── README.md
├── package.json
├── .gitignore
├── .editorconfig
├── bridge.mjs                  # CLI entry: daemon | init | status | new | logs | attach
├── lib/
│   ├── config.mjs              # loadConfig, saveState, paths, defaults
│   ├── telegram.mjs            # sendMessage, editMessageText, getUpdates, answerCallbackQuery
│   ├── tmux.mjs                # hasSession, ls, sendKeys, capturePane, pipePane, newSession
│   ├── fifo.mjs                # createFifo, openReadStream, unlinkFifo
│   ├── parser.mjs              # stripAnsi, detectPrompt, extractOptions
│   ├── streamer.mjs            # debounce + edit throttle + split (Streamer class)
│   ├── dispatcher.mjs          # routeMessage, routeCallback, runCommand
│   └── daemon.mjs              # main loop wiring + signal handlers + reattach
├── scripts/
│   ├── install.sh              # systemd unit + linger + start
│   └── uninstall.sh
├── systemd/
│   └── claude-bridge.service.template
└── test/
    ├── parser.test.mjs         # built-in node:test
    ├── streamer.test.mjs
    └── fixtures/
        ├── approve-prompt.txt
        └── menu-prompt.txt
```

Each file has a single responsibility; all modules are ESM `.mjs`. No `index.js` barrel — imports are explicit.

---

## PHASE 1 — Development (any OS, code-only)

### Task 1: Repo bootstrap

**Files:**
- Create: `claude-remote-bridge/` directory (parallel to existing projects, not nested inside an unrelated repository)

- [ ] **Step 1: Create the project directory**

Run in PowerShell (adjust the path to your preference; avoid placing the working tree under a cloud-synced folder to prevent file-watcher noise):

```powershell
New-Item -ItemType Directory -Force -Path "<your-projects-dir>\claude-remote-bridge"
Set-Location "<your-projects-dir>\claude-remote-bridge"
git init
git branch -M main
```

- [ ] **Step 2: Create `.gitignore`**

Create `.gitignore`:

```
node_modules/
*.log
.config/
state.json
config.json
.DS_Store
Thumbs.db
.vscode/
.idea/
```

- [ ] **Step 3: Create `.editorconfig`**

Create `.editorconfig`:

```
root = true

[*]
indent_style = space
indent_size = 4
end_of_line = lf
charset = utf-8
trim_trailing_whitespace = true
insert_final_newline = true

[*.md]
trim_trailing_whitespace = false
```

- [ ] **Step 4: First commit**

```powershell
git add .gitignore .editorconfig
git commit -m "chore: scaffold repo"
```

---

### Task 2: package.json + README skeleton

**Files:**
- Create: `package.json`
- Create: `README.md`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "claude-remote-bridge",
  "version": "0.1.0",
  "description": "Telegram-driven remote bridge for Claude Code CLI",
  "type": "module",
  "main": "bridge.mjs",
  "bin": {
    "claude-bridge": "./bridge.mjs"
  },
  "engines": {
    "node": ">=14"
  },
  "scripts": {
    "test": "node --test test/",
    "start": "node bridge.mjs daemon"
  },
  "dependencies": {},
  "devDependencies": {},
  "license": "UNLICENSED",
  "private": true
}
```

- [ ] **Step 2: Create `README.md`**

```markdown
# claude-remote-bridge

Control Claude Code CLI from your phone via Telegram.

## Quick setup (Ubuntu 22.04+ LTS)

```bash
# 1. Node 14+ (NodeSource)
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt install -y nodejs

# 2. Clone
git clone git@github.com:<your-handle>/claude-remote-bridge.git ~/dev/claude-remote-bridge
cd ~/dev/claude-remote-bridge

# 3. Configure
node bridge.mjs init       # paste bot token + chat_id

# 4. Install systemd service
./scripts/install.sh

# 5. Start a Claude tmux session
tmux new -d -s claude-myproject 'claude'

# 6. From your phone, message the bot:
#    /list            -> see sessions
#    /attach claude-myproject
#    type anything    -> sent to Claude
#    /detach          -> stop mirroring
```

## Architecture

See `docs/specs/2026-05-27-claude-remote-bridge-design.md`.

## License

Personal use.
```

- [ ] **Step 3: Commit**

```powershell
git add package.json README.md
git commit -m "chore: package.json + README skeleton"
```

---

### Task 3: lib/config.mjs — config and state loader

**Files:**
- Create: `lib/config.mjs`

- [ ] **Step 1: Create `lib/config.mjs`**

```js
import fs from 'fs/promises'
import path from 'path'
import os from 'os'

const CONFIG_DIR = path.join(os.homedir(), '.config', 'claude-bridge')
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json')
const STATE_FILE = path.join(CONFIG_DIR, 'state.json')

export const DEFAULTS = {
    silence_ms: 800,
    edit_throttle_ms: 1500,
    max_message_chars: 4000,
    snapshot_lines: 50,
    cursor_chars: ['❯', '►', '>'],
    fifo_dir: process.platform === 'linux'
        ? `/run/user/${process.getuid?.() ?? 1000}/claude-bridge`
        : path.join(os.tmpdir(), 'claude-bridge'),
}

export function getConfigPath() { return CONFIG_FILE }
export function getStatePath()  { return STATE_FILE }
export function getFifoDir(cfg) { return cfg.fifo_dir ?? DEFAULTS.fifo_dir }

async function readJson(p) {
    return JSON.parse(await fs.readFile(p, 'utf8'))
}

async function writeJson(p, obj, mode) {
    await fs.mkdir(path.dirname(p), { recursive: true })
    await fs.writeFile(p, JSON.stringify(obj, null, 2) + '\n', 'utf8')
    if (mode) {
        try { await fs.chmod(p, mode) } catch {}
    }
}

export async function loadConfig() {
    const envToken = process.env.TELEGRAM_BOT_TOKEN
    const envChat = process.env.TELEGRAM_CHAT_ID
    if (envToken && envChat) {
        return { ...DEFAULTS, bot_token: envToken, chat_id: envChat, allowed_chat_ids: [Number(envChat)] }
    }
    let raw
    try {
        raw = await readJson(CONFIG_FILE)
    } catch (e) {
        if (e.code === 'ENOENT') {
            throw new Error(
                `Config not found at ${CONFIG_FILE}\n` +
                `Run: node bridge.mjs init`
            )
        }
        throw e
    }
    if (!raw.bot_token) throw new Error('config.json missing bot_token')
    if (!raw.chat_id)   throw new Error('config.json missing chat_id')
    return {
        ...DEFAULTS,
        ...raw,
        allowed_chat_ids: raw.allowed_chat_ids ?? [Number(raw.chat_id)],
    }
}

export async function saveConfig(cfg) {
    const out = { ...cfg }
    delete out.fifo_dir  // computed, not stored
    await writeJson(CONFIG_FILE, out, 0o600)
}

export async function loadState() {
    try {
        return await readJson(STATE_FILE)
    } catch (e) {
        if (e.code === 'ENOENT') {
            return { attached_session: null, last_update_id: 0, outbound_message_id: null }
        }
        // Corrupt state file: warn, return empty
        process.stderr.write(`[warn] state.json corrupt: ${e.message}\n`)
        return { attached_session: null, last_update_id: 0, outbound_message_id: null }
    }
}

export async function saveState(state) {
    await writeJson(STATE_FILE, { ...state, saved_at: new Date().toISOString() }, 0o600)
}
```

- [ ] **Step 2: Smoke test on the development machine**

```powershell
node -e "import('./lib/config.mjs').then(m => console.log(m.DEFAULTS))"
```

Expected: prints the DEFAULTS object.

- [ ] **Step 3: Commit**

```powershell
git add lib/config.mjs
git commit -m "feat(config): load/save config + state from ~/.config/claude-bridge/"
```

---

### Task 4: lib/telegram.mjs — Bot API client

**Files:**
- Create: `lib/telegram.mjs`

- [ ] **Step 1: Create `lib/telegram.mjs`**

```js
import https from 'https'

const HOST = 'api.telegram.org'

function request(token, method, payload, timeoutMs = 35000) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify(payload || {})
        const req = https.request({
            method: 'POST',
            hostname: HOST,
            path: `/bot${token}/${method}`,
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
            },
            timeout: timeoutMs,
        }, (res) => {
            const chunks = []
            res.on('data', (c) => chunks.push(c))
            res.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf8')
                let parsed
                try { parsed = JSON.parse(raw) } catch { parsed = { ok: false, raw } }
                if (res.statusCode >= 200 && res.statusCode < 300 && parsed.ok) {
                    resolve(parsed.result)
                } else {
                    const err = new Error(parsed.description || `HTTP ${res.statusCode}`)
                    err.code = parsed.error_code ?? res.statusCode
                    err.parameters = parsed.parameters
                    err.method = method
                    reject(err)
                }
            })
        })
        req.on('error', reject)
        req.on('timeout', () => { req.destroy(new Error('telegram request timeout')) })
        req.write(body)
        req.end()
    })
}

export class TelegramClient {
    constructor(token) { this.token = token }

    getUpdates(offset, timeout = 30) {
        return request(this.token, 'getUpdates', { offset, timeout, allowed_updates: ['message', 'callback_query'] }, (timeout + 5) * 1000)
    }

    sendMessage(chatId, text, opts = {}) {
        return request(this.token, 'sendMessage', {
            chat_id: chatId,
            text,
            parse_mode: opts.parse_mode ?? 'Markdown',
            disable_web_page_preview: true,
            reply_markup: opts.reply_markup,
            reply_to_message_id: opts.reply_to_message_id,
            message_thread_id: opts.thread_id,
        })
    }

    editMessageText(chatId, messageId, text, opts = {}) {
        return request(this.token, 'editMessageText', {
            chat_id: chatId,
            message_id: messageId,
            text,
            parse_mode: opts.parse_mode ?? 'Markdown',
            disable_web_page_preview: true,
            reply_markup: opts.reply_markup,
        })
    }

    editMessageReplyMarkup(chatId, messageId, replyMarkup) {
        return request(this.token, 'editMessageReplyMarkup', {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: replyMarkup,
        })
    }

    answerCallbackQuery(callbackQueryId, text) {
        return request(this.token, 'answerCallbackQuery', {
            callback_query_id: callbackQueryId,
            text,
            show_alert: false,
        })
    }

    deleteWebhook() {
        return request(this.token, 'deleteWebhook', { drop_pending_updates: false })
    }

    getMe() {
        return request(this.token, 'getMe', {}, 10000)
    }
}

// Error code helpers
export function isRateLimit(err)      { return err?.code === 429 }
export function isNotModified(err)    { return err?.code === 400 && /not modified/i.test(err.message) }
export function isTooOldToEdit(err)   { return err?.code === 400 && /message to edit not found|message can't be edited/i.test(err.message) }
export function isInvalidToken(err)   { return err?.code === 401 }
```

- [ ] **Step 2: Commit**

```powershell
git add lib/telegram.mjs
git commit -m "feat(telegram): Bot API client (getUpdates, sendMessage, editMessageText, callback)"
```

---

### Task 5: lib/tmux.mjs — tmux command wrappers

**Files:**
- Create: `lib/tmux.mjs`

- [ ] **Step 1: Create `lib/tmux.mjs`**

```js
import { spawn } from 'child_process'

function run(args, opts = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn('tmux', args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts })
        let stdout = '', stderr = ''
        child.stdout.on('data', (d) => stdout += d.toString())
        child.stderr.on('data', (d) => stderr += d.toString())
        child.on('error', reject)
        child.on('close', (code) => {
            if (code === 0) resolve(stdout)
            else {
                const err = new Error(`tmux ${args.join(' ')} → exit ${code}: ${stderr.trim()}`)
                err.code = code
                err.stderr = stderr
                reject(err)
            }
        })
    })
}

export async function hasSession(name) {
    try {
        await run(['has-session', '-t', name])
        return true
    } catch {
        return false
    }
}

export async function listSessions() {
    try {
        const out = await run(['list-sessions', '-F', '#{session_name}\t#{session_attached}\t#{session_windows}'])
        return out.trim().split('\n').filter(Boolean).map(line => {
            const [name, attached, windows] = line.split('\t')
            return { name, attached: attached === '1', windows: Number(windows) }
        })
    } catch (e) {
        if (/no server running|no sessions/i.test(e.stderr || '')) return []
        throw e
    }
}

export async function sendKeys(session, text, { literal = true } = {}) {
    const args = ['send-keys', '-t', session]
    if (literal) args.push('-l')
    args.push(text)
    await run(args)
}

export async function sendEnter(session) {
    await run(['send-keys', '-t', session, 'Enter'])
}

export async function sendSpecialKey(session, key) {
    // key examples: 'Enter', 'Escape', 'Up', 'Down', 'Left', 'Right', 'C-c'
    await run(['send-keys', '-t', session, key])
}

export async function capturePane(session, { lines = 50, withEscapes = false } = {}) {
    const args = ['capture-pane', '-p', '-t', session, '-S', `-${lines}`]
    if (withEscapes) args.push('-e')
    return await run(args)
}

export async function pipePaneStart(session, command) {
    // Toggle off any existing pipe first to be safe
    try { await run(['pipe-pane', '-t', session]) } catch {}
    await run(['pipe-pane', '-O', '-t', session, command])
}

export async function pipePaneStop(session) {
    try { await run(['pipe-pane', '-t', session]) } catch {}
}

export async function newSession(name, { cwd, command = 'claude' } = {}) {
    const args = ['new-session', '-d', '-s', name]
    if (cwd) args.push('-c', cwd)
    args.push(command)
    await run(args)
}

export async function killSession(name) {
    await run(['kill-session', '-t', name])
}
```

- [ ] **Step 2: Commit**

```powershell
git add lib/tmux.mjs
git commit -m "feat(tmux): command wrappers around child_process.spawn('tmux', ...)"
```

---

### Task 6: lib/fifo.mjs — FIFO management

**Files:**
- Create: `lib/fifo.mjs`

- [ ] **Step 1: Create `lib/fifo.mjs`**

```js
import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import { spawn } from 'child_process'

function runMkfifo(p) {
    return new Promise((resolve, reject) => {
        const child = spawn('mkfifo', [p], { stdio: 'ignore' })
        child.on('error', reject)
        child.on('close', (code) => {
            if (code === 0) resolve()
            else reject(new Error(`mkfifo exit ${code}`))
        })
    })
}

export async function ensureFifoDir(dir) {
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 })
}

export async function createFifo(fifoPath) {
    // Idempotent: remove any stale FIFO from a previous run, then mkfifo
    try { await fsp.unlink(fifoPath) } catch (e) {
        if (e.code !== 'ENOENT') throw e
    }
    await runMkfifo(fifoPath)
}

export function openReadStream(fifoPath) {
    // O_NONBLOCK so open() does not block waiting for a writer
    const fd = fs.openSync(fifoPath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)
    return fs.createReadStream(null, { fd, autoClose: true, encoding: null })
}

export async function unlinkFifo(fifoPath) {
    try { await fsp.unlink(fifoPath) } catch (e) {
        if (e.code !== 'ENOENT') throw e
    }
}

export function fifoPathFor(dir, session) {
    return path.join(dir, `${session.replace(/[^A-Za-z0-9._-]/g, '_')}.fifo`)
}
```

- [ ] **Step 2: Commit**

```powershell
git add lib/fifo.mjs
git commit -m "feat(fifo): mkfifo + createReadStream + cleanup"
```

---

### Task 7: lib/parser.mjs and unit tests

**Files:**
- Create: `lib/parser.mjs`
- Create: `test/parser.test.mjs`
- Create: `test/fixtures/approve-prompt.txt` (sample data)
- Create: `test/fixtures/menu-prompt.txt`

- [ ] **Step 1: Create `lib/parser.mjs`**

```js
const ANSI_CSI   = /\x1b\[[0-9;?]*[a-zA-Z]/g
const ANSI_OSC   = /\x1b\][^\x07]*\x07/g
const ANSI_2BYTE = /\x1b[78MD]/g

export function stripAnsi(text) {
    return String(text)
        .replace(ANSI_CSI, '')
        .replace(ANSI_OSC, '')
        .replace(ANSI_2BYTE, '')
}

const CURSORS = ['❯', '►', '>']

function buildCursorPattern() {
    const escaped = CURSORS.map(c => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('')
    return new RegExp(`[${escaped}]`)
}

const CURSOR_RE = buildCursorPattern()

function lastN(text, n) {
    const lines = text.split('\n')
    return lines.slice(-n).join('\n')
}

function extractNumberedOptions(text) {
    // Match lines like "❯ 1. Yes" or "  2. No"
    const lines = text.split('\n')
    const options = []
    for (const line of lines) {
        const m = /^[\s❯►>]*(\d+)\.\s+(.+?)\s*$/.exec(line)
        if (m) options.push({ index: Number(m[1]), label: m[2].trim() })
    }
    return options
}

function extractMenuOptions(text) {
    // Find the cursor line, then collect a contiguous block of indented options around it
    const lines = text.split('\n')
    const cursorIdx = lines.findIndex(l => CURSOR_RE.test(l))
    if (cursorIdx < 0) return []
    // Walk up and down from the cursor as long as we see leading whitespace + non-empty content
    let start = cursorIdx, end = cursorIdx
    while (start > 0 && /^\s+\S/.test(lines[start - 1])) start--
    while (end < lines.length - 1 && /^\s+\S/.test(lines[end + 1])) end++
    const block = lines.slice(start, end + 1)
    return block.map((line, i) => {
        const label = line.replace(/^[\s❯►>]+/, '').trim()
        return { index: i, label, selected: CURSOR_RE.test(line) }
    }).filter(o => o.label.length > 0)
}

export function detectPrompt(plainText) {
    const last20 = lastN(plainText, 20)
    const hasCursor = CURSOR_RE.test(last20)

    if (!hasCursor) return { type: 'free' }

    // Approve dialogs are numbered (1. Yes / 2. ... / 3. No)
    const numbered = extractNumberedOptions(last20)
    const looksLikeApprove =
        numbered.length >= 2 &&
        numbered.length <= 5 &&
        /yes/i.test(numbered[0]?.label ?? '') &&
        (/proceed|approve|allow|do you want/i.test(last20))

    if (looksLikeApprove) {
        return { type: 'approve', options: numbered }
    }

    // Generic multi-choice menu
    const menuOpts = extractMenuOptions(last20)
    if (menuOpts.length >= 2) {
        return { type: 'menu', options: menuOpts }
    }

    return { type: 'free' }
}
```

- [ ] **Step 2: Create the sample fixtures**

Create `test/fixtures/approve-prompt.txt`:

```
                                                                                
Do you want to proceed with running this command?                               
                                                                                
❯ 1. Yes                                                                        
  2. Yes, and allow all sessions                                                
  3. No (Esc)                                                                   
                                                                                
```

Create `test/fixtures/menu-prompt.txt`:

```
What's your preference for the auth strategy?                                   
                                                                                
❯ OAuth via SSO                                                                 
  API key                                                                       
  Session cookie                                                                
                                                                                
```

- [ ] **Step 3: Create `test/parser.test.mjs`**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { stripAnsi, detectPrompt } from '../lib/parser.mjs'

test('stripAnsi removes CSI colour codes', () => {
    const input = '\x1b[31mhello\x1b[0m world'
    assert.equal(stripAnsi(input), 'hello world')
})

test('stripAnsi removes cursor positioning', () => {
    const input = 'before\x1b[2K\x1b[1Gafter'
    assert.equal(stripAnsi(input), 'beforeafter')
})

test('stripAnsi handles empty input', () => {
    assert.equal(stripAnsi(''), '')
})

test('detectPrompt: approve dialog', async () => {
    const text = await fs.readFile('test/fixtures/approve-prompt.txt', 'utf8')
    const result = detectPrompt(text)
    assert.equal(result.type, 'approve')
    assert.equal(result.options.length, 3)
    assert.equal(result.options[0].label, 'Yes')
    assert.equal(result.options[1].label, 'Yes, and allow all sessions')
    assert.equal(result.options[2].label, 'No (Esc)')
})

test('detectPrompt: multi-choice menu', async () => {
    const text = await fs.readFile('test/fixtures/menu-prompt.txt', 'utf8')
    const result = detectPrompt(text)
    assert.equal(result.type, 'menu')
    assert.ok(result.options.length >= 3)
    assert.equal(result.options[0].label, 'OAuth via SSO')
    assert.equal(result.options[0].selected, true)
})

test('detectPrompt: free text (no cursor)', () => {
    const result = detectPrompt('Just some output\nNo prompt here.\n')
    assert.equal(result.type, 'free')
})

test('detectPrompt: cursor but no menu structure', () => {
    const result = detectPrompt('> some text without a real menu\n')
    assert.equal(result.type, 'free')
})
```

- [ ] **Step 4: Run the tests**

```powershell
node --test test/parser.test.mjs
```

Expected: all 7 tests pass. If any fail, fix `parser.mjs` before continuing.

- [ ] **Step 5: Commit**

```powershell
git add lib/parser.mjs test/parser.test.mjs test/fixtures/
git commit -m "feat(parser): ANSI strip + prompt detection (approve/menu/free) + unit tests"
```

---

### Task 8: lib/streamer.mjs — debounce and edit throttle

**Files:**
- Create: `lib/streamer.mjs`
- Create: `test/streamer.test.mjs`

- [ ] **Step 1: Create `lib/streamer.mjs`**

```js
import { stripAnsi } from './parser.mjs'

/**
 * Streamer takes incoming pane bytes, debounces them, and dispatches to a sink (Telegram).
 *
 * Sink interface:
 *   sendNew(text) → Promise<message_id>
 *   edit(messageId, text) → Promise<void>
 *   onSilence(plainText, capture) → Promise<void>   // called once when the stream goes idle
 *
 * Time injection (for tests): pass `now` and `setTimer` via opts.
 */
export class Streamer {
    constructor(sink, {
        silenceMs = 800,
        editThrottleMs = 1500,
        maxMessageChars = 4000,
        now = Date.now,
        setTimer = setTimeout,
        clearTimer = clearTimeout,
    } = {}) {
        this.sink = sink
        this.silenceMs = silenceMs
        this.editThrottleMs = editThrottleMs
        this.maxMessageChars = maxMessageChars
        this.now = now
        this.setTimer = setTimer
        this.clearTimer = clearTimer

        this.buffer = ''
        this.currentMessageId = null
        this.lastEditAt = 0
        this.silenceTimer = null
        this.editTimer = null
        this.pending = Promise.resolve()
        this.aborted = false
    }

    abort() {
        this.aborted = true
        this.clearTimer(this.silenceTimer)
        this.clearTimer(this.editTimer)
    }

    push(chunk) {
        if (this.aborted) return
        const text = stripAnsi(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
        if (!text) return
        this.buffer += text

        // Truncate the head on overflow (keep the tail)
        if (this.buffer.length > this.maxMessageChars * 2) {
            this.buffer = '[…truncated…]\n' + this.buffer.slice(-this.maxMessageChars)
            // Force a new message after truncation
            this.currentMessageId = null
        }

        // Reset the silence timer
        this.clearTimer(this.silenceTimer)
        this.silenceTimer = this.setTimer(() => this._onSilence(), this.silenceMs)

        // Schedule an edit if we are not throttled
        this._scheduleEdit()

        // Split if the buffer exceeds the max
        if (this.buffer.length >= this.maxMessageChars) {
            this._finalizeAndSplit()
        }
    }

    _scheduleEdit() {
        if (this.editTimer) return
        const elapsed = this.now() - this.lastEditAt
        const wait = Math.max(0, this.editThrottleMs - elapsed)
        this.editTimer = this.setTimer(() => this._flushEdit(), wait)
    }

    async _flushEdit() {
        this.editTimer = null
        if (this.aborted || this.buffer.length === 0) return
        const snapshot = this._formatForTelegram(this.buffer)
        try {
            if (this.currentMessageId == null) {
                this.currentMessageId = await this.sink.sendNew(snapshot)
            } else {
                await this.sink.edit(this.currentMessageId, snapshot)
            }
            this.lastEditAt = this.now()
        } catch (e) {
            // Telegram error handling delegated to the sink
            this.sink.onError?.(e)
            if (e.code === 400 && /not found|can't be edited/i.test(e.message)) {
                this.currentMessageId = null
            }
        }
    }

    async _onSilence() {
        // Final flush, then notify the sink so it can run capture-pane and parse
        await this._flushEdit()
        try {
            await this.sink.onSilence?.(this.buffer)
        } catch (e) {
            this.sink.onError?.(e)
        }
        // Reset for the next stream
        this.buffer = ''
        this.currentMessageId = null
    }

    async _finalizeAndSplit() {
        await this._flushEdit()
        this.buffer = ''
        this.currentMessageId = null
    }

    _formatForTelegram(text) {
        // Wrap in a code block to preserve whitespace
        const truncated = text.length > this.maxMessageChars
            ? text.slice(-this.maxMessageChars)
            : text
        return '```\n' + truncated.replace(/```/g, '``​`') + '\n```'
    }
}
```

- [ ] **Step 2: Create `test/streamer.test.mjs`**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Streamer } from '../lib/streamer.mjs'

function makeFakeClock() {
    let current = 0
    const timers = []
    return {
        now: () => current,
        setTimer: (cb, delay) => {
            const t = { cb, fireAt: current + delay, cancelled: false }
            timers.push(t)
            return t
        },
        clearTimer: (t) => { if (t) t.cancelled = true },
        advance: async (ms) => {
            const target = current + ms
            // Fire timers in order
            timers.sort((a, b) => a.fireAt - b.fireAt)
            for (const t of timers) {
                if (t.cancelled) continue
                if (t.fireAt <= target) {
                    current = t.fireAt
                    t.cancelled = true
                    await t.cb()
                }
            }
            current = target
        },
    }
}

function makeFakeSink() {
    const events = []
    let nextId = 100
    return {
        events,
        sendNew: async (text) => {
            const id = nextId++
            events.push({ type: 'sendNew', id, text })
            return id
        },
        edit: async (id, text) => { events.push({ type: 'edit', id, text }) },
        onSilence: async (buf) => { events.push({ type: 'silence', buf }) },
        onError: (e) => { events.push({ type: 'error', message: e.message }) },
    }
}

test('Streamer: first chunk sends new message after throttle wait', async () => {
    const clock = makeFakeClock()
    const sink = makeFakeSink()
    const s = new Streamer(sink, { silenceMs: 800, editThrottleMs: 1500, ...clock })
    s.push('hello')
    await clock.advance(1500)
    const sends = sink.events.filter(e => e.type === 'sendNew')
    assert.equal(sends.length, 1)
    assert.match(sends[0].text, /hello/)
})

test('Streamer: silence triggers onSilence', async () => {
    const clock = makeFakeClock()
    const sink = makeFakeSink()
    const s = new Streamer(sink, { silenceMs: 800, editThrottleMs: 1500, ...clock })
    s.push('hello')
    await clock.advance(2000)
    const silenceEvents = sink.events.filter(e => e.type === 'silence')
    assert.equal(silenceEvents.length, 1)
})

test('Streamer: subsequent chunks edit the same message', async () => {
    const clock = makeFakeClock()
    const sink = makeFakeSink()
    const s = new Streamer(sink, { silenceMs: 2000, editThrottleMs: 100, ...clock })
    s.push('part1')
    await clock.advance(150)
    s.push('part2')
    await clock.advance(150)
    s.push('part3')
    await clock.advance(150)
    const edits = sink.events.filter(e => e.type === 'edit')
    assert.ok(edits.length >= 1, `expected at least 1 edit, got ${edits.length}`)
})

test('Streamer: ANSI is stripped', async () => {
    const clock = makeFakeClock()
    const sink = makeFakeSink()
    const s = new Streamer(sink, { silenceMs: 800, editThrottleMs: 0, ...clock })
    s.push('\x1b[31mred\x1b[0m text')
    await clock.advance(100)
    const sends = sink.events.filter(e => e.type === 'sendNew')
    assert.ok(!sends[0].text.includes('\x1b'))
    assert.match(sends[0].text, /red text/)
})

test('Streamer: abort prevents further sends', async () => {
    const clock = makeFakeClock()
    const sink = makeFakeSink()
    const s = new Streamer(sink, { silenceMs: 800, editThrottleMs: 0, ...clock })
    s.abort()
    s.push('hello')
    await clock.advance(2000)
    assert.equal(sink.events.length, 0)
})
```

- [ ] **Step 3: Run the tests**

```powershell
node --test test/streamer.test.mjs
```

Expected: all 5 tests pass.

- [ ] **Step 4: Run all tests together**

```powershell
node --test test/
```

Expected: parser tests plus streamer tests all pass (12 total).

- [ ] **Step 5: Commit**

```powershell
git add lib/streamer.mjs test/streamer.test.mjs
git commit -m "feat(streamer): debounce + edit throttle + split + unit tests"
```

---

### Task 9: lib/dispatcher.mjs — command and callback handlers

**Files:**
- Create: `lib/dispatcher.mjs`

- [ ] **Step 1: Create `lib/dispatcher.mjs`**

```js
import * as tmux from './tmux.mjs'

/**
 * Dispatcher routes Telegram updates → bridge actions.
 *
 * Context interface (`ctx`):
 *   state: { attached, ... } shared bridge state
 *   config: loaded config
 *   tg: TelegramClient
 *   chatId: target chat id
 *   attach(name): Promise<void>
 *   detach(): Promise<void>
 *   sendStatus(): Promise<void>
 */

export async function routeUpdate(update, ctx) {
    if (update.message) {
        return routeMessage(update.message, ctx)
    }
    if (update.callback_query) {
        return routeCallback(update.callback_query, ctx)
    }
}

function isAllowed(fromId, ctx) {
    return ctx.config.allowed_chat_ids.map(Number).includes(Number(fromId))
}

async function routeMessage(msg, ctx) {
    if (!isAllowed(msg.from.id, ctx)) return
    const text = (msg.text ?? '').trim()
    if (!text) return

    if (text.startsWith('/')) {
        return runCommand(text, ctx)
    }
    // Plain text → send to the attached session
    if (!ctx.state.attached) {
        await ctx.tg.sendMessage(ctx.chatId, '⚠️ Not attached. Use `/list` then `/attach <name>`.')
        return
    }
    try {
        await tmux.sendKeys(ctx.state.attached.session, text, { literal: true })
        await tmux.sendEnter(ctx.state.attached.session)
    } catch (e) {
        await ctx.tg.sendMessage(ctx.chatId, `❌ send-keys failed: ${e.message}`)
    }
}

async function routeCallback(cb, ctx) {
    if (!isAllowed(cb.from.id, ctx)) {
        return ctx.tg.answerCallbackQuery(cb.id, 'Not authorized')
    }
    const data = cb.data || ''
    // data formats:
    //   approve:1  → send "1" + Enter
    //   approve:2  → send "2" + Enter
    //   approve:no → send Escape
    //   menu:N     → send Down*N + Enter (N is the target index from the top, 0-based)
    //   key:Enter|Escape|Up|Down → send special key
    //   confirm:kill:<name> → kill session after confirmation
    try {
        if (data.startsWith('approve:')) {
            const action = data.slice(8)
            if (action === 'no') {
                await tmux.sendSpecialKey(ctx.state.attached.session, 'Escape')
            } else {
                await tmux.sendKeys(ctx.state.attached.session, action, { literal: true })
                await tmux.sendEnter(ctx.state.attached.session)
            }
            await ctx.tg.answerCallbackQuery(cb.id, `Sent: ${action}`)
        } else if (data.startsWith('menu:')) {
            const target = Number(data.slice(5))
            const current = ctx.state.attached?.menuCursor ?? 0
            const delta = target - current
            const key = delta >= 0 ? 'Down' : 'Up'
            for (let i = 0; i < Math.abs(delta); i++) {
                await tmux.sendSpecialKey(ctx.state.attached.session, key)
            }
            await tmux.sendEnter(ctx.state.attached.session)
            await ctx.tg.answerCallbackQuery(cb.id, `Selected option ${target + 1}`)
        } else if (data.startsWith('key:')) {
            const key = data.slice(4)
            await tmux.sendSpecialKey(ctx.state.attached.session, key)
            await ctx.tg.answerCallbackQuery(cb.id, `Pressed ${key}`)
        } else if (data.startsWith('confirm:kill:')) {
            const name = data.slice(13)
            await tmux.killSession(name)
            await ctx.tg.answerCallbackQuery(cb.id, `Killed ${name}`)
            await ctx.tg.sendMessage(ctx.chatId, `💀 Killed session \`${name}\``)
        } else {
            await ctx.tg.answerCallbackQuery(cb.id, 'Unknown action')
        }
    } catch (e) {
        await ctx.tg.answerCallbackQuery(cb.id, `Error: ${e.message}`.slice(0, 200))
    }
}

async function runCommand(text, ctx) {
    const [cmd, ...args] = text.split(/\s+/)
    switch (cmd) {
        case '/help':    return cmdHelp(ctx)
        case '/list':    return cmdList(ctx)
        case '/attach':  return cmdAttach(args[0], ctx)
        case '/detach':  return cmdDetach(ctx)
        case '/status':  return cmdStatus(ctx)
        case '/new':     return cmdNew(args[0], ctx)
        case '/kill':    return cmdKill(args[0], ctx)
        case '/raw':     return cmdRaw(args.join(' '), ctx)
        default:
            return ctx.tg.sendMessage(ctx.chatId, `Unknown command: \`${cmd}\`. Try /help.`)
    }
}

async function cmdHelp(ctx) {
    const lines = [
        '*claude-remote-bridge*',
        '`/list`               — list tmux sessions',
        '`/attach <name>`      — mirror this session',
        '`/detach`             — stop mirroring',
        '`/status`             — bridge state',
        '`/new <name>`         — create + attach',
        '`/kill <name>`        — kill (2-step confirm)',
        '`/raw <text>`         — send text without Enter',
        '',
        ctx.state.attached
            ? `Currently attached to: \`${ctx.state.attached.session}\``
            : 'Not attached.',
    ]
    await ctx.tg.sendMessage(ctx.chatId, lines.join('\n'))
}

async function cmdList(ctx) {
    const sessions = await tmux.listSessions()
    if (sessions.length === 0) {
        return ctx.tg.sendMessage(ctx.chatId, '_No tmux sessions running._\nStart one with `tmux new -d -s <name> "claude"`')
    }
    const lines = sessions.map(s => {
        const marker = ctx.state.attached?.session === s.name ? '📡 ' : '   '
        const att = s.attached ? ' (local-attached)' : ''
        return `${marker}\`${s.name}\` — ${s.windows} window(s)${att}`
    })
    await ctx.tg.sendMessage(ctx.chatId, lines.join('\n'))
}

async function cmdAttach(name, ctx) {
    if (!name) return ctx.tg.sendMessage(ctx.chatId, 'Usage: `/attach <session-name>`')
    if (!(await tmux.hasSession(name))) {
        const sessions = await tmux.listSessions()
        const list = sessions.map(s => `\`${s.name}\``).join(', ') || '(none)'
        return ctx.tg.sendMessage(ctx.chatId, `Session \`${name}\` not found.\nAvailable: ${list}`)
    }
    try {
        await ctx.attach(name)
        await ctx.tg.sendMessage(ctx.chatId, `📡 Attached to \`${name}\`. Send messages to chat with Claude.`)
    } catch (e) {
        await ctx.tg.sendMessage(ctx.chatId, `❌ Attach failed: ${e.message}`)
    }
}

async function cmdDetach(ctx) {
    if (!ctx.state.attached) {
        return ctx.tg.sendMessage(ctx.chatId, '_Not attached._')
    }
    const name = ctx.state.attached.session
    await ctx.detach()
    await ctx.tg.sendMessage(ctx.chatId, `🔌 Detached from \`${name}\`. Session still running.`)
}

async function cmdStatus(ctx) {
    const uptime = Math.floor((Date.now() - ctx.state.startedAt) / 1000)
    const lines = [
        `*Bridge status*`,
        `Uptime: ${uptime}s`,
        `Attached: ${ctx.state.attached ? `\`${ctx.state.attached.session}\`` : '_none_'}`,
        `Last FIFO byte: ${ctx.state.lastFifoByteAt ? new Date(ctx.state.lastFifoByteAt).toISOString() : 'never'}`,
        `Errors last hour: ${ctx.state.errorsLastHour}`,
    ]
    await ctx.tg.sendMessage(ctx.chatId, lines.join('\n'))
}

async function cmdNew(name, ctx) {
    if (!name) return ctx.tg.sendMessage(ctx.chatId, 'Usage: `/new <session-name>`')
    if (await tmux.hasSession(name)) {
        return ctx.tg.sendMessage(ctx.chatId, `Session \`${name}\` already exists. Use /attach.`)
    }
    try {
        await tmux.newSession(name)
        await ctx.tg.sendMessage(ctx.chatId, `🆕 Created \`${name}\`. Attaching...`)
        await ctx.attach(name)
    } catch (e) {
        await ctx.tg.sendMessage(ctx.chatId, `❌ Create failed: ${e.message}`)
    }
}

async function cmdKill(name, ctx) {
    if (!name) return ctx.tg.sendMessage(ctx.chatId, 'Usage: `/kill <session-name>`')
    if (!(await tmux.hasSession(name))) {
        return ctx.tg.sendMessage(ctx.chatId, `Session \`${name}\` does not exist.`)
    }
    await ctx.tg.sendMessage(ctx.chatId, `⚠️ Kill \`${name}\`?`, {
        reply_markup: {
            inline_keyboard: [[
                { text: '💀 Yes, kill', callback_data: `confirm:kill:${name}` },
                { text: 'Cancel', callback_data: 'cancel' },
            ]],
        },
    })
}

async function cmdRaw(text, ctx) {
    if (!ctx.state.attached) {
        return ctx.tg.sendMessage(ctx.chatId, '_Not attached._')
    }
    if (!text) return ctx.tg.sendMessage(ctx.chatId, 'Usage: `/raw <text>` (sends without Enter)')
    await tmux.sendKeys(ctx.state.attached.session, text, { literal: true })
    await ctx.tg.sendMessage(ctx.chatId, `Sent (no Enter): \`${text.slice(0, 100)}\``)
}
```

- [ ] **Step 2: Commit**

```powershell
git add lib/dispatcher.mjs
git commit -m "feat(dispatcher): command + callback handlers (/help /list /attach /detach /status /new /kill /raw)"
```

---

### Task 10: lib/daemon.mjs — main loop wiring

**Files:**
- Create: `lib/daemon.mjs`

- [ ] **Step 1: Create `lib/daemon.mjs`**

```js
import path from 'path'
import { TelegramClient, isRateLimit, isInvalidToken } from './telegram.mjs'
import * as tmux from './tmux.mjs'
import * as fifo from './fifo.mjs'
import { Streamer } from './streamer.mjs'
import { detectPrompt } from './parser.mjs'
import { routeUpdate } from './dispatcher.mjs'
import { loadConfig, loadState, saveState, getFifoDir } from './config.mjs'

function log(level, actor, msg) {
    process.stderr.write(`[${level}] [${actor}] ${msg}\n`)
}

export async function runDaemon() {
    const config = await loadConfig()
    const state = await loadState()
    const tg = new TelegramClient(config.bot_token)
    const fifoDir = getFifoDir(config)
    await fifo.ensureFifoDir(fifoDir)

    // Defensive: clear any webhook so getUpdates works
    try {
        await tg.deleteWebhook()
    } catch (e) {
        log('warn', 'telegram', `deleteWebhook failed: ${e.message}`)
        if (isInvalidToken(e)) {
            log('error', 'telegram', 'Invalid bot token. Run: node bridge.mjs init')
            process.exit(78)  // EX_CONFIG
        }
    }

    const bridgeState = {
        attached: null,
        startedAt: Date.now(),
        lastFifoByteAt: 0,
        errorsLastHour: 0,
    }

    let lastUpdateId = state.last_update_id ?? 0

    async function attach(sessionName) {
        if (bridgeState.attached) {
            await detach()
        }
        const fifoPath = fifo.fifoPathFor(fifoDir, sessionName)
        await fifo.createFifo(fifoPath)
        // Open the read stream BEFORE pipe-pane so `cat` doesn't block on open
        const stream = fifo.openReadStream(fifoPath)
        await tmux.pipePaneStart(sessionName, `cat > ${JSON.stringify(fifoPath)}`)

        const sink = {
            sendNew: async (text) => {
                const msg = await tg.sendMessage(config.chat_id, text)
                return msg.message_id
            },
            edit: async (id, text) => {
                await tg.editMessageText(config.chat_id, id, text)
            },
            onSilence: async (_buf) => {
                // Capture the pane, detect a prompt
                try {
                    const captured = await tmux.capturePane(sessionName, { lines: config.snapshot_lines })
                    const prompt = detectPrompt(captured)
                    if (prompt.type === 'approve') {
                        await sendApproveButtons(prompt.options)
                    } else if (prompt.type === 'menu') {
                        await sendMenuButtons(prompt.options)
                        bridgeState.attached.menuCursor = prompt.options.findIndex(o => o.selected)
                    }
                } catch (e) {
                    log('warn', 'parser', `silence handler failed: ${e.message}`)
                }
            },
            onError: (e) => {
                bridgeState.errorsLastHour++
                log('warn', 'streamer', e.message)
            },
        }

        const streamer = new Streamer(sink, {
            silenceMs: config.silence_ms,
            editThrottleMs: config.edit_throttle_ms,
            maxMessageChars: config.max_message_chars,
        })

        stream.on('data', (chunk) => {
            bridgeState.lastFifoByteAt = Date.now()
            streamer.push(chunk)
        })
        stream.on('error', (e) => log('warn', 'fifo', e.message))
        stream.on('end', () => log('info', 'fifo', `EOF on ${fifoPath}`))

        bridgeState.attached = { session: sessionName, fifoPath, stream, streamer, menuCursor: 0 }
        state.attached_session = sessionName
        await saveState({ ...state, attached_session: sessionName })
        log('info', 'attach', `attached to ${sessionName}`)
    }

    async function detach() {
        if (!bridgeState.attached) return
        const { session, fifoPath, stream, streamer } = bridgeState.attached
        streamer.abort()
        stream.destroy()
        try { await tmux.pipePaneStop(session) } catch {}
        await fifo.unlinkFifo(fifoPath)
        bridgeState.attached = null
        state.attached_session = null
        await saveState({ ...state, attached_session: null })
        log('info', 'detach', `detached from ${session}`)
    }

    async function sendApproveButtons(options) {
        const inline = options.map(o => ({
            text: o.label.length > 25 ? o.label.slice(0, 22) + '…' : o.label,
            callback_data: `approve:${o.index}`,
        }))
        await tg.sendMessage(config.chat_id, '👇 Approve prompt detected:', {
            reply_markup: { inline_keyboard: [inline] },
        })
    }

    async function sendMenuButtons(options) {
        const buttons = options.slice(0, 8).map((o, i) => ({
            text: `${i + 1}. ${o.label.length > 20 ? o.label.slice(0, 17) + '…' : o.label}`,
            callback_data: `menu:${i}`,
        }))
        // Split into rows of 2
        const rows = []
        for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2))
        await tg.sendMessage(config.chat_id, '👇 Choose an option:', {
            reply_markup: { inline_keyboard: rows },
        })
    }

    async function sendStatus() { /* delegated to dispatcher cmdStatus */ }

    const ctx = {
        state: bridgeState,
        config,
        tg,
        chatId: config.chat_id,
        attach,
        detach,
        sendStatus,
    }

    // Restore the previously attached session if any
    if (state.attached_session) {
        if (await tmux.hasSession(state.attached_session)) {
            try {
                await attach(state.attached_session)
                await tg.sendMessage(config.chat_id, `🔄 Bridge restarted — reattached to \`${state.attached_session}\``)
            } catch (e) {
                log('warn', 'reattach', e.message)
                state.attached_session = null
                await saveState({ ...state, attached_session: null })
            }
        } else {
            await tg.sendMessage(config.chat_id, `🔄 Bridge restarted — previous session \`${state.attached_session}\` no longer exists`)
            state.attached_session = null
            await saveState({ ...state, attached_session: null })
        }
    } else {
        await tg.sendMessage(config.chat_id, `🤖 Bridge online. Send /help for commands.`)
    }

    // Signal handlers
    let shuttingDown = false
    const shutdown = async (signal) => {
        if (shuttingDown) return
        shuttingDown = true
        log('info', 'daemon', `received ${signal}, shutting down`)
        await detach().catch(() => {})
        await saveState({ ...state, last_update_id: lastUpdateId, outbound_message_id: null })
        process.exit(0)
    }
    process.on('SIGTERM', () => shutdown('SIGTERM'))
    process.on('SIGINT',  () => shutdown('SIGINT'))
    process.on('uncaughtException', async (e) => {
        log('error', 'daemon', `uncaughtException: ${e.stack || e.message}`)
        await saveState({ ...state, last_update_id: lastUpdateId, outbound_message_id: null }).catch(() => {})
        process.exit(1)
    })

    // Telegram long-poll loop
    log('info', 'daemon', `started; polling Telegram (offset=${lastUpdateId})`)
    let backoff = 1000
    while (!shuttingDown) {
        try {
            const updates = await tg.getUpdates(lastUpdateId + 1, 30)
            backoff = 1000
            for (const update of updates) {
                lastUpdateId = Math.max(lastUpdateId, update.update_id)
                try {
                    await routeUpdate(update, ctx)
                } catch (e) {
                    log('error', 'dispatch', `update ${update.update_id}: ${e.message}`)
                }
            }
            if (updates.length > 0) {
                await saveState({ ...state, last_update_id: lastUpdateId })
            }
        } catch (e) {
            if (isInvalidToken(e)) {
                log('error', 'telegram', 'Invalid token — shutting down')
                process.exit(78)
            }
            if (isRateLimit(e)) {
                const wait = (e.parameters?.retry_after ?? 5) * 1000
                log('warn', 'telegram', `rate limited, sleeping ${wait}ms`)
                await new Promise(r => setTimeout(r, wait))
                continue
            }
            log('warn', 'telegram', `poll error: ${e.message}; backoff ${backoff}ms`)
            await new Promise(r => setTimeout(r, backoff))
            backoff = Math.min(backoff * 2, 60000)
        }
    }
}
```

- [ ] **Step 2: Commit**

```powershell
git add lib/daemon.mjs
git commit -m "feat(daemon): main loop wiring (Telegram poll + FIFO + parser + dispatcher)"
```

---

### Task 11: bridge.mjs — CLI entry point

**Files:**
- Create: `bridge.mjs`

- [ ] **Step 1: Create `bridge.mjs`**

```js
#!/usr/bin/env node
import readline from 'readline'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { spawn, spawnSync } from 'child_process'
import { TelegramClient } from './lib/telegram.mjs'
import { loadConfig, saveConfig, loadState, getConfigPath, getStatePath, DEFAULTS } from './lib/config.mjs'
import { runDaemon } from './lib/daemon.mjs'
import * as tmux from './lib/tmux.mjs'

function fail(msg, code = 1) {
    process.stderr.write(`bridge: ${msg}\n`)
    process.exit(code)
}

function info(msg) {
    process.stderr.write(`bridge: ${msg}\n`)
}

async function cmdInit() {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
    const ask = (prompt) => new Promise(resolve => rl.question(prompt, resolve))

    info('Setting up Telegram credentials.')
    process.stderr.write(
        '  1. Create or reuse a bot at https://t.me/BotFather → /newbot\n' +
        '  2. Copy the bot token.\n' +
        '  3. Add the bot to a private chat with yourself. Open:\n' +
        '     https://api.telegram.org/bot<TOKEN>/getUpdates\n' +
        '     Look for "chat":{"id": …}\n\n'
    )

    // Try to import from an existing credentials file
    const candidates = [
        path.join(os.homedir(), '.config', 'claude-bridge-tg', 'credentials.json'),
    ]
    let imported = null
    for (const p of candidates) {
        try {
            const c = JSON.parse(await fs.readFile(p, 'utf8'))
            if (c.bot_token && c.chat_id) {
                const yn = (await ask(`Found existing creds at ${p}. Import? [Y/n] `)).trim().toLowerCase()
                if (yn !== 'n') imported = c
                break
            }
        } catch {}
    }

    const bot_token = imported?.bot_token ?? (await ask('Bot token: ')).trim()
    const chat_id   = imported?.chat_id   ?? (await ask('Chat ID: ')).trim()
    const allowRaw  = (await ask(`Allowed user IDs (comma-separated, leave blank = [${chat_id}]): `)).trim()
    rl.close()

    if (!bot_token || !chat_id) fail('bot_token and chat_id required')

    const allowed_chat_ids = allowRaw
        ? allowRaw.split(',').map(s => Number(s.trim())).filter(Boolean)
        : [Number(chat_id)]

    const cfg = { bot_token, chat_id, allowed_chat_ids, ...DEFAULTS }
    await saveConfig(cfg)
    info(`Saved → ${getConfigPath()}`)
    info('Verifying token...')
    const tg = new TelegramClient(bot_token)
    const bot = await tg.getMe()
    info(`OK — bot @${bot.username}`)
}

async function cmdStatus() {
    try {
        const cfg = await loadConfig()
        const st = await loadState()
        info(`config:           ${getConfigPath()}`)
        info(`bot chat_id:      ${cfg.chat_id}`)
        info(`allowed_chat_ids: ${cfg.allowed_chat_ids.join(', ')}`)
        info(`state.attached:   ${st.attached_session ?? '(none)'}`)
        info(`state.last_update_id: ${st.last_update_id}`)
        // Check systemd
        const sd = spawnSync('systemctl', ['--user', 'is-active', 'claude-bridge.service'], { encoding: 'utf8' })
        info(`systemd status:   ${sd.stdout.trim() || 'unknown'}`)
    } catch (e) {
        fail(e.message)
    }
}

async function cmdLogs() {
    spawn('journalctl', ['--user', '-u', 'claude-bridge.service', '-f', '-n', '50'], { stdio: 'inherit' })
}

async function cmdNew(name, cwd) {
    if (!name) fail('Usage: bridge new <session-name> [cwd]')
    if (await tmux.hasSession(name)) fail(`Session ${name} already exists`)
    await tmux.newSession(name, { cwd })
    info(`Created tmux session ${name}`)
}

async function cmdAttach(name) {
    fail('CLI attach not implemented yet — use Telegram /attach. (Use `bridge logs` to watch the daemon.)')
}

function cmdHelp() {
    process.stdout.write(`bridge — claude-remote-bridge CLI

Commands:
  daemon                 Run the bridge daemon (foreground; used by systemd)
  init                   Interactive: configure bot token + chat_id + allowlist
  status                 Show config + state + systemd status
  logs                   Tail journalctl --user -u claude-bridge.service
  new <name> [cwd]       tmux new -d -s <name> -c <cwd> 'claude'
  attach <name>          (not implemented — use Telegram /attach)
  help                   Show this help

Config path: ${getConfigPath()}
State path:  ${getStatePath()}
`)
}

async function main() {
    const [sub, ...rest] = process.argv.slice(2)
    try {
        switch (sub) {
            case 'daemon': await runDaemon(); break
            case 'init':   await cmdInit();   break
            case 'status': await cmdStatus(); break
            case 'logs':   await cmdLogs();   break
            case 'new':    await cmdNew(rest[0], rest[1]); break
            case 'attach': await cmdAttach(rest[0]); break
            case 'help':
            case '--help':
            case '-h':
            case undefined: cmdHelp(); break
            default:
                fail(`Unknown command: ${sub}. Try: bridge help`)
        }
    } catch (e) {
        fail(e.stack || e.message)
    }
}

main()
```

- [ ] **Step 2: Smoke test on the development machine**

```powershell
node bridge.mjs help
```

Expected: prints the help block listing all commands.

```powershell
node bridge.mjs status
```

Expected: errors with "Config not found" (no config has been created yet — that is the correct error).

- [ ] **Step 3: Commit**

```powershell
git add bridge.mjs
git commit -m "feat(cli): bridge.mjs entry (daemon/init/status/logs/new/attach/help)"
```

---

### Task 12: systemd unit template

**Files:**
- Create: `systemd/claude-bridge.service.template`

- [ ] **Step 1: Create `systemd/claude-bridge.service.template`**

```ini
[Unit]
Description=Claude Code Telegram Bridge
After=default.target

[Service]
Type=simple
ExecStart=__NODE_PATH__ __BRIDGE_PATH__ daemon
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
```

- [ ] **Step 2: Commit**

```powershell
git add systemd/claude-bridge.service.template
git commit -m "feat(deploy): systemd user service template"
```

---

### Task 13: install.sh and uninstall.sh

**Files:**
- Create: `scripts/install.sh`
- Create: `scripts/uninstall.sh`

- [ ] **Step 1: Create `scripts/install.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BRIDGE="${REPO_DIR}/bridge.mjs"
NODE_PATH="$(command -v node)"

if [[ -z "${NODE_PATH}" ]]; then
    echo "node not found in PATH. Install Node 14+ first:"
    echo "  curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -"
    echo "  sudo apt install -y nodejs"
    exit 1
fi

NODE_VERSION="$(node --version)"
echo "Using node: ${NODE_PATH} (${NODE_VERSION})"

if [[ ! -f "${BRIDGE}" ]]; then
    echo "bridge.mjs not found at ${BRIDGE}"
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

# Enable linger so the service runs after logout
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
```

- [ ] **Step 2: Create `scripts/uninstall.sh`**

```bash
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
```

- [ ] **Step 3: Mark the scripts executable (applies on Linux; on Windows, git tracks the bit)**

```powershell
git update-index --chmod=+x scripts/install.sh scripts/uninstall.sh
```

- [ ] **Step 4: Commit**

```powershell
git add scripts/install.sh scripts/uninstall.sh
git commit -m "feat(deploy): install.sh + uninstall.sh for Ubuntu systemd user service"
```

---

### Task 14: README polish

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Replace `README.md` with the fuller version**

```markdown
# claude-remote-bridge

Control Claude Code CLI from your phone via Telegram. Approve tool calls, pick menu options, and chat with Claude — from anywhere.

## How it works

`tmux pipe-pane` streams Claude TUI output → FIFO → Node daemon → Telegram. Telegram messages → `tmux send-keys` → Claude. The daemon is always on as a systemd user service; it activates only when you `/attach` from your phone.

Single Node 14+ process, zero npm dependencies.

## Setup (Ubuntu 22.04+ LTS)

```bash
# 1. Install Node 14+ (NodeSource — apt's version is too old)
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt install -y nodejs

# 2. Install tmux if missing
sudo apt install -y tmux

# 3. Clone
git clone git@github.com:<your-handle>/claude-remote-bridge.git ~/dev/claude-remote-bridge
cd ~/dev/claude-remote-bridge

# 4. Configure (paste bot token from BotFather + your chat_id)
node bridge.mjs init

# 5. Install systemd user service + enable linger
./scripts/install.sh

# 6. Verify
node bridge.mjs status
journalctl --user -u claude-bridge.service -f
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
| `/attach <name>` | Start mirroring the session |
| `/detach` | Stop mirroring |
| `/status` | Show bridge state |
| `/new <name>` | Create + attach a new session |
| `/kill <name>` | Kill a session (2-step confirm) |
| `/raw <text>` | Send text without Enter (paste) |

When attached, plain text messages are forwarded via `send-keys` to Claude. Inline buttons appear automatically when an approve dialog or menu is detected.

## Architecture

See `docs/specs/2026-05-27-claude-remote-bridge-design.md` for the full design.

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
# The Telegram bot must not have a webhook set; the daemon clears it on start

# tmux session died unexpectedly
tmux ls                       # see what's there
# Bridge auto-detaches when the session dies
```

## Development

```bash
# Run tests
node --test test/

# Run the daemon in the foreground (for development)
node bridge.mjs daemon

# Tail logs
node bridge.mjs logs
```

## License

Personal use.
```

- [ ] **Step 2: Commit**

```powershell
git add README.md
git commit -m "docs(readme): full setup + daily-use + troubleshooting"
```

---

### Task 15: Push to GitHub

**Files:** none (remote operation)

- [ ] **Step 1: Create the GitHub repository (choose one option)**

**Option A (recommended):** if the `gh` CLI is installed and authenticated:

```powershell
gh repo create claude-remote-bridge --private --source=. --remote=origin --description "Telegram remote bridge for Claude Code CLI"
```

**Option B:** use the web UI to create an empty private repo named `claude-remote-bridge`, then:

```powershell
git remote add origin git@github.com:<your-handle>/claude-remote-bridge.git
```

- [ ] **Step 2: Push the main branch**

```powershell
git push -u origin main
```

Expected: the branch is tracked and all commits are visible on GitHub.

- [ ] **Step 3: Verify clone-readiness**

Open the repo in the GitHub web UI. Confirm:
- README renders correctly.
- No `config.json` or `state.json` is checked in (gitignore is working).
- `package.json` shows zero dependencies.

- [ ] **Step 4: (Optional) Tag the Phase 1 snapshot**

```powershell
git tag -a v0.1.0-pre-verify -m "End of Phase 1: code-only, untested on Linux"
git push origin v0.1.0-pre-verify
```

---

## PHASE 2 — Linux deployment (verify, install, test)

### Task 16: Pre-code verification (do this FIRST on the Linux host)

**Goal:** Verify the 5 environmental assumptions BEFORE running the bridge. If any fails, fix it or adjust the bridge code before running the daemon.

- [ ] **Step 1: Node 14+ installed**

```bash
node --version
```

Expected: `v14.x.x` or higher.

If you get `command not found` or a version below 14:

```bash
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt install -y nodejs
node --version    # should now report a current LTS version
```

- [ ] **Step 2: tmux 3.0+ installed**

```bash
tmux -V
```

Expected: `tmux 3.0` or higher.

If missing: `sudo apt install -y tmux`

- [ ] **Step 3: FIFO + pipe-pane round-trip works**

In one terminal:

```bash
mkdir -p /run/user/$UID/claude-bridge
mkfifo /run/user/$UID/claude-bridge/test.fifo
tmux new -d -s verify 'bash -c "while true; do echo hello at $(date +%T); sleep 1; done"'
tmux pipe-pane -O -t verify "cat > /run/user/$UID/claude-bridge/test.fifo"
```

In a second terminal:

```bash
cat /run/user/$UID/claude-bridge/test.fifo
```

Expected: lines like `hello at 14:30:01` appearing every second.

Cleanup:

```bash
tmux pipe-pane -t verify
tmux kill-session -t verify
rm /run/user/$UID/claude-bridge/test.fifo
```

If the FIFO blocks or no output appears, `fifo.mjs` may need adjusted open flags. Record any oddities for Task 20.

- [ ] **Step 4: `tmux capture-pane` produces the expected text**

```bash
tmux new -d -s verify2 'echo line1; echo line2; echo line3; sleep 60'
sleep 1
tmux capture-pane -p -t verify2 -S -10
tmux kill-session -t verify2
```

Expected: prints `line1` / `line2` / `line3` (plain text, no escape codes). If escape codes appear, the parser needs `stripAnsi` on capture-pane output as well (already handled).

- [ ] **Step 5: Telegram getUpdates long-poll works**

Replace `<TOKEN>` with your bot token. Avoid pasting the token into shell history — use a here-doc or environment variable:

```bash
read -s TOKEN
curl -s "https://api.telegram.org/bot${TOKEN}/deleteWebhook"
curl -s "https://api.telegram.org/bot${TOKEN}/getUpdates?timeout=5"
unset TOKEN
```

Expected: JSON `{"ok":true,"result":[…]}` returns within 5 seconds (or up to the timeout if there are no messages).

- [ ] **Step 6: systemd user + linger work**

```bash
systemctl --user status
loginctl show-user "$USER" | grep Linger
```

If `Linger=no` and sudo access is not available right now, the bridge can still run interactively (`node bridge.mjs daemon` inside a tmux pane). Otherwise:

```bash
sudo loginctl enable-linger "$USER"
```

---

### Task 17: Clone + Node setup (if not already done in Task 16)

- [ ] **Step 1: SSH key for GitHub (skip if already authenticated)**

```bash
ssh -T git@github.com
# If it fails: ssh-keygen + add the key to GitHub Settings → SSH Keys
```

- [ ] **Step 2: Clone**

```bash
mkdir -p ~/dev
cd ~/dev
git clone git@github.com:<your-handle>/claude-remote-bridge.git
cd claude-remote-bridge
```

- [ ] **Step 3: Run tests (re-verify they still pass on Linux)**

```bash
node --test test/
```

Expected: 12 tests pass (5 parser + 5 streamer + others). If any pass on the development machine but fail on Linux, the cause is most likely line-ending differences. Confirm `.editorconfig` is in effect and re-clone with proper line-ending handling.

---

### Task 18: Configure the bridge

- [ ] **Step 1: Run init**

```bash
node bridge.mjs init
```

If a previously stored credentials file exists at `~/.config/claude-bridge-tg/credentials.json`, init will prompt to import it; accept if appropriate. Otherwise paste the bot token and chat_id manually.

Set `allowed_chat_ids` to your numeric Telegram user ID (the same as chat_id for a private chat).

- [ ] **Step 2: Verify status**

```bash
node bridge.mjs status
```

Expected: prints the config path, chat_id, and allowed_chat_ids. The systemd status will report `inactive` (the service is not installed yet).

- [ ] **Step 3: Smoke-run the daemon in the foreground**

```bash
node bridge.mjs daemon
```

Expected:
- Log line: `[info] [daemon] started; polling Telegram (offset=0)`
- Telegram receives: `🤖 Bridge online. Send /help for commands.`

From your phone, send `/help`. The bot should reply with the command list.

Press Ctrl+C to stop, then proceed to the systemd install.

---

### Task 19: Install the systemd service

- [ ] **Step 1: Run the install script**

```bash
./scripts/install.sh
```

Expected output:
- `Wrote ~/.config/systemd/user/claude-bridge.service`
- (if needed) `Enabling lingering for user <user>` followed by a sudo prompt
- systemd unit enabled and started

- [ ] **Step 2: Verify the service is active**

```bash
systemctl --user status claude-bridge.service
```

Expected: `Active: active (running)`.

- [ ] **Step 3: Check the logs**

```bash
journalctl --user -u claude-bridge.service -n 20
```

Expected: log lines such as `[info] [daemon] started; polling Telegram`.

- [ ] **Step 4: Test restart behavior**

```bash
systemctl --user restart claude-bridge.service
journalctl --user -u claude-bridge.service -n 10
```

Telegram should receive `🤖 Bridge online.` again on restart.

---

### Task 20: Manual end-to-end test and bug fixes

- [ ] **Step 1: Start a Claude tmux session**

```bash
tmux new -d -s claude-test -c ~ 'claude'
```

Verify it started:

```bash
tmux ls
# claude-test: 1 windows (created ...)
```

- [ ] **Step 2: Attach from your phone**

Send to the bot:

```
/list
```

Expected reply: lists `claude-test` (not currently attached).

Send:

```
/attach claude-test
```

Expected: `📡 Attached to claude-test. Send messages to chat with Claude.`

You should also see Claude's initial prompt mirrored into Telegram within ~1-2 seconds.

- [ ] **Step 3: Chat test**

Send from your phone:

```
Hello Claude, what's 2+2?
```

Expected: Claude responds and the response streams to Telegram — initially one message that edits in place at roughly 1.5s intervals, then a final flush.

- [ ] **Step 4: Approve test**

Send from your phone:

```
Can you list files in current directory using bash?
```

Claude will hit an approve prompt (Bash tool). Expected:
- A Telegram message shows the approve dialog text in a code block.
- A second message arrives with inline buttons `[1. Yes][2. Yes,…][3. No]`.

Tap `1. Yes`. Expected:
- The callback is dismissed.
- Bash output streams back.

- [ ] **Step 5: Menu test (manual trigger)**

Ask Claude something that triggers `AskUserQuestion` (the multi-choice menu). For example:

```
I have three options for the auth strategy — pick one for me.
```

Claude may render an `AskUserQuestion` menu (depending on the model). If so:
- A Telegram message displays the menu options.
- Inline buttons render for each option.

Tap one. Expected: the selection works and Claude proceeds with that option.

If the parser misses the menu, fall back to plain text (`1`, `↓`, `Enter`) — this should still work.

- [ ] **Step 6: Detach + reattach**

```
/detach
```

Expected: `🔌 Detached from claude-test.`

Send a chat message — the bot should reply `⚠️ Not attached.`

```
/attach claude-test
```

Output should start mirroring again from the point of reattach (not historical output).

- [ ] **Step 7: Bridge restart while attached**

On the Linux host:

```bash
systemctl --user restart claude-bridge.service
```

Expected: Telegram receives `🔄 Bridge restarted — reattached to claude-test`. Chat continues to work normally.

- [ ] **Step 8: Document any bugs**

Create a new branch `fix/phase-2-bugs` if issues surface. Common Linux-specific gotchas:

- **FIFO open blocks**: if `openReadStream` hangs, the `O_NONBLOCK` flag may not be respected. Fix `lib/fifo.mjs` to use `fs.createReadStream` with explicit `flags: 'r'`.
- **`pipe-pane` reorders chunks**: some tmux versions buffer differently. Try `pipe-pane -I` to also pipe to input (unlikely to be needed) or check the tmux version.
- **`capture-pane` includes ANSI**: the bridge already calls `stripAnsi` in `lib/parser.mjs#detectPrompt` — but if `tmux capture-pane` returns raw escapes by default, the strip is applied twice (harmless).
- **`send-keys` interprets `-l`**: tmux requires the `-l` flag to appear BEFORE the text. Verify in `lib/tmux.mjs#sendKeys`.

For each bug:
1. Reproduce it in isolation (using manual tmux commands).
2. Fix in code.
3. Verify the fix.
4. Commit with a clear message: `fix(<area>): <root cause>`.

- [ ] **Step 9: Final commit and push fixes**

```bash
git add -A
git commit -m "fix(linux): bugs found during E2E"
git push origin main
```

If you used a Phase 1 tag and want a stable rollback point:

```bash
git tag -a v0.1.0 -m "Phase 2 stable on Ubuntu"
git push origin v0.1.0
```

---

## Self-review

### Spec coverage

Spec sections vs tasks:

| Spec section | Implementing task(s) |
|---|---|
| §2 Top-level architecture | Tasks 3-10 implement all 5 components |
| §3.1 Commands `/help` `/list` `/attach` `/detach` `/status` | Task 9 (dispatcher) |
| §3.1 `/new` (later phase) | Task 9 includes `/new` (built into the dispatcher) — verify in Phase 2 |
| §3.1 `/kill` `/raw` (later phase) | Task 9 includes both — verify in Phase 2 |
| §3.2 Plain text message | Task 9 `routeMessage` |
| §3.3 Inline buttons | Task 10 `sendApproveButtons`, `sendMenuButtons` |
| §3.5 Authorization allowlist | Task 9 `isAllowed` |
| §4.1 FIFO live + snapshot | Task 10 attach() + onSilence handler |
| §4.3 Streaming edit-in-place | Task 8 Streamer class |
| §4.4 ANSI strip | Task 7 stripAnsi |
| §4.5 detectPrompt | Task 7 detectPrompt |
| §4.7 Tunable params | Task 3 DEFAULTS |
| §5.5 State file format | Task 3 loadState/saveState |
| §5.7 systemd unit | Task 12 template + Task 13 install |
| §6 Repo structure | Tasks 1-14 |
| §7 Phasing | Phase 1 = Tasks 1-15, Phase 2 = Tasks 16-20 |
| §8 Error handling | Task 10 daemon backoff/retry, Task 4 telegram error helpers |
| §10 Pre-code verification | Task 16 |

Gaps: none material. Spec §3.1 lists `/help` for the first phase — covered.

### Placeholder scan

Searched for "TBD", "TODO", "fill in", "implement later", "similar to". None are present in the plan tasks. The README mentions `<your-handle>` as a deliberate placeholder for the user's GitHub handle at install time — not a plan gap.

### Type / name consistency

- `Streamer` class: `push()`, `abort()` methods consistent across the task definition and its usage in the daemon (Task 10).
- `bridgeState.attached` shape: `{ session, fifoPath, stream, streamer, menuCursor }` — declared in Task 10 attach(), consumed in Task 9 dispatcher (`ctx.state.attached.session`, `ctx.state.attached.menuCursor`).
- `tmux.sendKeys(session, text, { literal })`, `tmux.sendEnter(session)`, `tmux.sendSpecialKey(session, key)` — defined in Task 5, used in Tasks 9 and 10.
- Callback data formats `approve:N`, `menu:N`, `key:X`, `confirm:kill:NAME` — defined in Task 9 routeCallback, encoded by Task 10 sendApproveButtons / sendMenuButtons.

All consistent.

---

## Execution Handoff

**Plan complete and saved to `docs/plans/2026-05-27-claude-remote-bridge.md`.**

Two execution options:

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task with review between tasks for fast iteration. Better for parallelisable tasks (parser, streamer, and tmux are independent).

**2. Inline Execution** — execute tasks within this session using executing-plans, batched execution with checkpoints. Better when you want to watch every step.

Which approach do you prefer?
