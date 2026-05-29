# Telegram file/image upload into the Claude session — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user send a photo/document in Telegram; the bridge downloads it into `<cwd>/.claude-bridge/uploads/` and replies with the saved path (no typing into the Claude TUI).

**Architecture:** Approach A — extend `lib/telegram.ts` (new types + `getFile`/`downloadFile`), add a focused `lib/attachments.ts` (pure naming/picking logic + a download-and-write orchestrator), and wire one branch into `lib/dispatcher.ts` `routeMessage`. cwd is fetched fresh via `tmux.paneCwd(session)` at save time; `daemon.ts`/`AttachedSession` are untouched.

**Tech Stack:** TypeScript (strict, ESM NodeNext, Node 14+ floor), zero runtime deps, Node built-in `https`/`fs/promises`. Tests use the in-repo mini-runner (`test/_runner.ts`).

**Spec:** `docs/superpowers/specs/2026-05-29-telegram-file-upload-to-claude-design.md`

---

## File structure

- **Modify** `lib/telegram.ts` — add `PhotoSize`/`Document`/`TelegramFile` types, extend `TelegramMessage` (`photo?`/`document?`/`caption?`), add a binary GET helper, add `TelegramClient.getFile` + `TelegramClient.downloadFile`.
- **Create** `lib/attachments.ts` — `PickedAttachment` type, `pickAttachment`, `sanitizeName`, `resolveTarget`, `saveAttachment`.
- **Modify** `lib/dispatcher.ts` — import from `attachments.js`, add the attachment branch + `handleAttachment` helper in `routeMessage`.
- **Create** `test/attachments.test.ts` — unit tests for the pure logic + `saveAttachment` (fake `tg`, no network).
- **Modify** `test/dispatcher.test.ts` — one test for the photo-while-not-attached path.
- **Modify** `package.json` — add `dist/test/attachments.test.js` to the `test` script.

Build/test commands used throughout:
- Build: `npm run build` (runs `tsc`).
- Run one test file: `npx tsc && node dist/test/_runner.js dist/test/attachments.test.js`
- Full suite: `npm test`

---

## Task 1: Telegram types + file download methods

**Files:**
- Modify: `lib/telegram.ts`

- [ ] **Step 1: Add the attachment/file types**

In `lib/telegram.ts`, immediately **after** the `TelegramMessage` interface, add:

```ts
export interface PhotoSize {
    file_id: string
    file_unique_id: string
    width: number
    height: number
    file_size?: number
}

export interface Document {
    file_id: string
    file_unique_id: string
    file_name?: string
    mime_type?: string
    file_size?: number
}

export interface TelegramFile {
    file_id: string
    file_unique_id: string
    file_size?: number
    file_path?: string
}
```

- [ ] **Step 2: Extend `TelegramMessage`**

In the existing `TelegramMessage` interface, add three fields after `message_thread_id?: number`:

```ts
    photo?: PhotoSize[]
    document?: Document
    caption?: string
```

- [ ] **Step 3: Add a binary GET helper**

In `lib/telegram.ts`, immediately **after** the existing `request<T>(...)` function, add:

```ts
// Binary GET against the file endpoint. Unlike request() (which POSTs JSON to
// /bot<token>/<method>), Telegram file downloads are a GET on a different path
// and return raw bytes.
function requestBinary(token: string, filePath: string, timeoutMs = 60000): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const req = https.request({
            method: 'GET',
            hostname: HOST,
            path: `/file/bot${token}/${filePath}`,
            timeout: timeoutMs,
        }, (res) => {
            const status = res.statusCode ?? 0
            const chunks: Buffer[] = []
            res.on('data', (c: Buffer) => chunks.push(c))
            res.on('end', () => {
                if (status >= 200 && status < 300) resolve(Buffer.concat(chunks))
                else reject(new Error(`file download HTTP ${status}`))
            })
        })
        req.on('error', reject)
        req.on('timeout', () => { req.destroy(new Error('telegram file download timeout')) })
        req.end()
    })
}
```

- [ ] **Step 4: Add `getFile` + `downloadFile` to `TelegramClient`**

Inside the `TelegramClient` class, after the `getMe()` method, add:

```ts
    getFile(fileId: string): Promise<TelegramFile> {
        return request<TelegramFile>(this.token, 'getFile', { file_id: fileId }, 10000)
    }

    downloadFile(filePath: string): Promise<Buffer> {
        return requestBinary(this.token, filePath)
    }
```

- [ ] **Step 5: Build to verify it type-checks**

Run: `npm run build`
Expected: completes with no errors (exit 0), `dist/lib/telegram.js` updated. (These additions are types + thin `https` wrappers, exercised via the fake `tg` in Task 6 — no direct unit test.)

- [ ] **Step 6: Commit**

```bash
git add lib/telegram.ts
git commit -m "feat(telegram): add file types + getFile/downloadFile"
```

---

## Task 2: Scaffold `lib/attachments.ts`

Create the module with the public surface as throwing stubs so later test files compile and fail at runtime (clean TDD) rather than failing to build.

**Files:**
- Create: `lib/attachments.ts`

- [ ] **Step 1: Create the file with stubs**

Create `lib/attachments.ts`:

```ts
import fs from 'fs/promises'
import path from 'path'
import type { TelegramClient, TelegramMessage } from './telegram.js'

export interface PickedAttachment {
    fileId: string
    suggestedName: string
    fileSize?: number
}

export function pickAttachment(_msg: TelegramMessage): PickedAttachment | null {
    throw new Error('not implemented')
}

export function sanitizeName(_name: string): string {
    throw new Error('not implemented')
}

export async function resolveTarget(_dir: string, _name: string): Promise<string> {
    throw new Error('not implemented')
}

export async function saveAttachment(
    _tg: Pick<TelegramClient, 'getFile' | 'downloadFile'>,
    _fileId: string,
    _suggestedName: string,
    _cwd: string,
): Promise<{ relPath: string; bytes: number }> {
    throw new Error('not implemented')
}
```

- [ ] **Step 2: Build to verify it compiles**

Run: `npm run build`
Expected: exit 0, `dist/lib/attachments.js` produced. (`fs`/`path` imports are used by later steps; strict TS will not flag unused imports.)

- [ ] **Step 3: Commit**

```bash
git add lib/attachments.ts
git commit -m "feat(attachments): scaffold module surface"
```

---

## Task 3: `sanitizeName`

**Files:**
- Create: `test/attachments.test.ts`
- Modify: `lib/attachments.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/attachments.test.ts`:

```ts
import { test } from './_runner.js'
import { strict as assert } from 'assert'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { pickAttachment, sanitizeName, resolveTarget, saveAttachment } from '../lib/attachments.js'
import type { TelegramClient, TelegramMessage } from '../lib/telegram.js'

test('sanitizeName: strips path traversal and separators', () => {
    assert.equal(sanitizeName('../../etc/passwd'), 'passwd')
    assert.equal(sanitizeName('a/b/c.txt'), 'c.txt')
})

test('sanitizeName: keeps safe chars, collapses the rest', () => {
    assert.equal(sanitizeName('a_b-c.PNG'), 'a_b-c.PNG')
    assert.equal(sanitizeName('hi there!.jpg'), 'hi_there_.jpg')
})

test('sanitizeName: empty / all-bad falls back to "file"', () => {
    assert.equal(sanitizeName(''), 'file')
    assert.equal(sanitizeName('///'), 'file')
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsc && node dist/test/_runner.js dist/test/attachments.test.js`
Expected: the `sanitizeName` tests print `not ok` with `Error: not implemented`.

- [ ] **Step 3: Implement `sanitizeName`**

In `lib/attachments.ts`, replace the `sanitizeName` stub body with:

```ts
export function sanitizeName(name: string): string {
    // basename only — drop any directory components a malicious name carries
    const base = name.split(/[\\/]/).pop() ?? ''
    const cleaned = base
        .replace(/[^A-Za-z0-9._-]+/g, '_')  // allowlist; collapse runs to one '_'
        .replace(/^[._-]+/, '')              // no leading dot/dash (no hidden/odd names)
    return cleaned.length > 0 ? cleaned : 'file'
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx tsc && node dist/test/_runner.js dist/test/attachments.test.js`
Expected: the three `sanitizeName` tests print `ok` (the not-yet-implemented `pickAttachment`/`resolveTarget`/`saveAttachment` are not tested yet).

- [ ] **Step 5: Commit**

```bash
git add lib/attachments.ts test/attachments.test.ts
git commit -m "feat(attachments): sanitizeName"
```

---

## Task 4: `pickAttachment`

**Files:**
- Modify: `test/attachments.test.ts`
- Modify: `lib/attachments.ts`

- [ ] **Step 1: Add the failing tests**

Append to `test/attachments.test.ts`:

```ts
test('pickAttachment: document → file_id + name + size', () => {
    const msg = {
        document: { file_id: 'D1', file_unique_id: 'u1', file_name: 'report.pdf', file_size: 123 },
    } as unknown as TelegramMessage
    const a = pickAttachment(msg)
    assert.equal(a?.fileId, 'D1')
    assert.equal(a?.suggestedName, 'report.pdf')
    assert.equal(a?.fileSize, 123)
})

test('pickAttachment: document without name → file-<unique_id>', () => {
    const msg = { document: { file_id: 'D2', file_unique_id: 'u2' } } as unknown as TelegramMessage
    assert.equal(pickAttachment(msg)?.suggestedName, 'file-u2')
})

test('pickAttachment: photo → largest size, jpg name', () => {
    const msg = {
        photo: [
            { file_id: 'P_s', file_unique_id: 'us', width: 90, height: 90 },
            { file_id: 'P_l', file_unique_id: 'ul', width: 1280, height: 720 },
        ],
    } as unknown as TelegramMessage
    const a = pickAttachment(msg)
    assert.equal(a?.fileId, 'P_l')
    assert.equal(a?.suggestedName, 'photo-ul.jpg')
})

test('pickAttachment: neither → null', () => {
    assert.equal(pickAttachment({ text: 'hi' } as unknown as TelegramMessage), null)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsc && node dist/test/_runner.js dist/test/attachments.test.js`
Expected: the four `pickAttachment` tests print `not ok` with `Error: not implemented`.

- [ ] **Step 3: Implement `pickAttachment`**

In `lib/attachments.ts`, replace the `pickAttachment` stub body with:

```ts
export function pickAttachment(msg: TelegramMessage): PickedAttachment | null {
    // Documents win over photos: sending as a document is an explicit
    // "use this exact file" signal.
    if (msg.document) {
        const d = msg.document
        return {
            fileId: d.file_id,
            suggestedName: d.file_name ?? `file-${d.file_unique_id}`,
            fileSize: d.file_size,
        }
    }
    if (msg.photo && msg.photo.length > 0) {
        const largest = msg.photo.reduce((a, b) =>
            b.width * b.height >= a.width * a.height ? b : a)
        return {
            fileId: largest.file_id,
            suggestedName: `photo-${largest.file_unique_id}.jpg`,
            fileSize: largest.file_size,
        }
    }
    return null
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx tsc && node dist/test/_runner.js dist/test/attachments.test.js`
Expected: all `sanitizeName` + `pickAttachment` tests print `ok`.

- [ ] **Step 5: Commit**

```bash
git add lib/attachments.ts test/attachments.test.ts
git commit -m "feat(attachments): pickAttachment"
```

---

## Task 5: `resolveTarget`

**Files:**
- Modify: `test/attachments.test.ts`
- Modify: `lib/attachments.ts`

- [ ] **Step 1: Add the failing test**

Append to `test/attachments.test.ts`:

```ts
test('resolveTarget: collisions get -1, -2 suffixes before the extension', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'att-'))
    const first = await resolveTarget(dir, 'a.txt')
    assert.equal(path.basename(first), 'a.txt')
    await fs.writeFile(first, 'x')
    const second = await resolveTarget(dir, 'a.txt')
    assert.equal(path.basename(second), 'a-1.txt')
    await fs.writeFile(second, 'x')
    const third = await resolveTarget(dir, 'a.txt')
    assert.equal(path.basename(third), 'a-2.txt')
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsc && node dist/test/_runner.js dist/test/attachments.test.js`
Expected: the `resolveTarget` test prints `not ok` with `Error: not implemented`.

- [ ] **Step 3: Implement `resolveTarget`**

In `lib/attachments.ts`, replace the `resolveTarget` stub body with:

```ts
export async function resolveTarget(dir: string, name: string): Promise<string> {
    const ext = path.extname(name)
    const stem = name.slice(0, name.length - ext.length)
    let candidate = path.join(dir, name)
    let n = 0
    while (true) {
        try {
            await fs.access(candidate)  // resolves if the path exists
        } catch {
            return candidate            // does not exist → free to use
        }
        n++
        candidate = path.join(dir, `${stem}-${n}${ext}`)
    }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx tsc && node dist/test/_runner.js dist/test/attachments.test.js`
Expected: all tests so far print `ok`.

- [ ] **Step 5: Commit**

```bash
git add lib/attachments.ts test/attachments.test.ts
git commit -m "feat(attachments): resolveTarget collision handling"
```

---

## Task 6: `saveAttachment`

**Files:**
- Modify: `test/attachments.test.ts`
- Modify: `lib/attachments.ts`

- [ ] **Step 1: Add the failing test**

Append to `test/attachments.test.ts`:

```ts
test('saveAttachment: downloads via fake tg and writes under <cwd>/.claude-bridge/uploads', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'cwd-'))
    const fakeTg: Pick<TelegramClient, 'getFile' | 'downloadFile'> = {
        getFile: async (id: string) => ({ file_id: id, file_unique_id: 'u', file_path: 'photos/x.jpg' }),
        downloadFile: async () => Buffer.from('hello-bytes'),
    }
    const { relPath, bytes } = await saveAttachment(fakeTg, 'F1', 'shot.png', cwd)
    assert.equal(relPath, path.join('.claude-bridge', 'uploads', 'shot.png'))
    assert.equal(bytes, Buffer.from('hello-bytes').length)
    const written = await fs.readFile(path.join(cwd, relPath))
    assert.equal(written.toString(), 'hello-bytes')
})

test('saveAttachment: throws when getFile returns no file_path', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'cwd-'))
    const fakeTg: Pick<TelegramClient, 'getFile' | 'downloadFile'> = {
        getFile: async (id: string) => ({ file_id: id, file_unique_id: 'u' }),
        downloadFile: async () => Buffer.from(''),
    }
    await assert.rejects(() => saveAttachment(fakeTg, 'F1', 'shot.png', cwd), /file_path/)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsc && node dist/test/_runner.js dist/test/attachments.test.js`
Expected: the two `saveAttachment` tests print `not ok` with `Error: not implemented`.

- [ ] **Step 3: Implement `saveAttachment`**

In `lib/attachments.ts`, replace the `saveAttachment` stub body with:

```ts
export async function saveAttachment(
    tg: Pick<TelegramClient, 'getFile' | 'downloadFile'>,
    fileId: string,
    suggestedName: string,
    cwd: string,
): Promise<{ relPath: string; bytes: number }> {
    const file = await tg.getFile(fileId)
    if (!file.file_path) throw new Error('Telegram getFile returned no file_path')
    const buf = await tg.downloadFile(file.file_path)
    const dir = path.join(cwd, '.claude-bridge', 'uploads')
    await fs.mkdir(dir, { recursive: true })
    const target = await resolveTarget(dir, sanitizeName(suggestedName))
    await fs.writeFile(target, buf)
    return { relPath: path.relative(cwd, target), bytes: buf.length }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx tsc && node dist/test/_runner.js dist/test/attachments.test.js`
Expected: every test in the file prints `ok`, ending with `N passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add lib/attachments.ts test/attachments.test.ts
git commit -m "feat(attachments): saveAttachment download+write"
```

---

## Task 7: Wire into the dispatcher

**Files:**
- Modify: `lib/dispatcher.ts`
- Modify: `test/dispatcher.test.ts`

- [ ] **Step 1: Add the failing dispatcher test (photo while not attached)**

In `test/dispatcher.test.ts`, add a photo-message builder after the existing `cb(...)` builder:

```ts
function photoMsg(opts: { fromId?: number; thread_id?: number } = {}): TelegramUpdate {
    return {
        update_id: 1,
        message: {
            message_id: 1,
            from: { id: opts.fromId ?? 100, is_bot: false },
            chat: { id: 100, type: 'private' },
            date: 0,
            photo: [{ file_id: 'P1', file_unique_id: 'u1', width: 100, height: 100 }],
            message_thread_id: opts.thread_id,
        } as unknown as TelegramMessage,
    }
}
```

Then add this test at the end of the file:

```ts
test('dispatcher: photo while not attached → "Chưa attach" warning', async () => {
    const { ctx, tg } = makeCtx()
    await routeUpdate(photoMsg(), ctx)
    assert.equal(tg.sends.length, 1)
    assert.match(tg.sends[0].text, /Chưa attach/)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsc && node dist/test/_runner.js dist/test/dispatcher.test.js`
Expected: the new test prints `not ok` — the photo has no `text`, so the current `routeMessage` hits `if (!text) return` and never replies (`tg.sends.length` is `0`, assertion fails).

- [ ] **Step 3: Import the attachments helpers**

In `lib/dispatcher.ts`, add after the existing `import { escapeHtml } from './telegram.js'` line (split value vs type to match the repo's `import type` convention):

```ts
import { pickAttachment, saveAttachment } from './attachments.js'
import type { PickedAttachment } from './attachments.js'
```

- [ ] **Step 4: Add the attachment branch in `routeMessage`**

In `routeMessage`, immediately **after** the `if (!isCorrectThread(msg, ctx)) return` line and **before** `const text = (msg.text ?? '').trim()`, insert:

```ts
    const attachment = pickAttachment(msg)
    if (attachment) {
        await handleAttachment(attachment, ctx)
        return
    }
```

- [ ] **Step 5: Add the `handleAttachment` helper**

In `lib/dispatcher.ts`, add this function immediately **after** the `routeMessage` function:

```ts
async function handleAttachment(att: PickedAttachment, ctx: Ctx): Promise<void> {
    if (!ctx.state.attached) {
        await ctx.tg.sendMessage(ctx.chatId, '⚠️ Chưa attach session nào — không biết lưu vào đâu. Dùng `/attach` trước.')
        return
    }
    if (att.fileSize && att.fileSize > 20 * 1024 * 1024) {
        await ctx.tg.sendMessage(ctx.chatId, '❌ File quá lớn (>20MB) — Telegram bot không tải được.')
        return
    }
    const session = ctx.state.attached.session
    let cwd: string
    try {
        cwd = await tmux.paneCwd(session)
    } catch (e) {
        await ctx.tg.sendMessage(ctx.chatId, `❌ Không lấy được thư mục làm việc: ${errMsg(e)}`)
        return
    }
    try {
        const { relPath, bytes } = await saveAttachment(ctx.tg, att.fileId, att.suggestedName, cwd)
        const kb = (bytes / 1024).toFixed(1)
        await ctx.tg.sendMessage(ctx.chatId, `📎 Đã lưu \`${relPath}\` (${kb} KB). Tham chiếu path này cho Claude khi cần.`)
    } catch (e) {
        await ctx.tg.sendMessage(ctx.chatId, `❌ Lưu file thất bại: ${errMsg(e)}`)
    }
}
```

- [ ] **Step 6: Run to verify it passes**

Run: `npx tsc && node dist/test/_runner.js dist/test/dispatcher.test.js`
Expected: the new `photo while not attached` test prints `ok`; all existing dispatcher tests still `ok`.

- [ ] **Step 7: Commit**

```bash
git add lib/dispatcher.ts test/dispatcher.test.ts
git commit -m "feat(dispatcher): save Telegram photo/document attachments into the session cwd"
```

---

## Task 8: Register the new test file + full green run

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add `attachments.test.js` to the test script**

In `package.json`, change the `test` script value from:

```
tsc && node dist/test/_runner.js dist/test/parser.test.js dist/test/streamer.test.js dist/test/dispatcher.test.js dist/test/daemon.test.js dist/test/telegram.test.js
```

to (append `dist/test/attachments.test.js`):

```
tsc && node dist/test/_runner.js dist/test/parser.test.js dist/test/streamer.test.js dist/test/dispatcher.test.js dist/test/daemon.test.js dist/test/telegram.test.js dist/test/attachments.test.js
```

- [ ] **Step 2: Run the full suite**

Run: `npm test`
Expected: ends with `N passed, 0 failed` (N = previous 40 + new attachments tests + the new dispatcher test), exit 0.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "test: run attachments.test in the suite"
```

---

## Manual verification (after merge, optional)

Not automated (needs a live Telegram chat + tmux session):
1. `npm run build && node dist/bridge.js daemon`, `/attach <session>`.
2. Send a photo from Telegram → expect `📎 Đã lưu .claude-bridge/uploads/photo-<id>.jpg (… KB)`.
3. Send a document (e.g. a `.log`) → expect it saved under the same folder with its original name.
4. Send a photo while detached → expect the "Chưa attach" warning.
5. Confirm the file exists in the session's cwd and Claude can read it by the reported path.
6. Suggest adding `.claude-bridge/` to the project's `.gitignore` (the bridge does not edit user repos).
