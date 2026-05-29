# Design: Telegram file/image upload into the Claude session

- **Date:** 2026-05-29
- **Status:** Approved (design); implementation pending
- **Scope:** One feature, one implementation plan.

## Overview

Let the user send a photo or document from Telegram and have the bridge
**download it into the attached session's working directory**, then reply with
the saved path. The user can then reference that path when talking to Claude
(e.g. "look at `.claude-bridge/uploads/screenshot.png` and fix the layout").

The bridge does **not** type anything into the Claude TUI for this feature — it
only saves the file and reports the path. This keeps the feature simple and
side-effect-free on the live session.

## Goals

- Accept both Telegram **photos** (compressed) and **documents** (any file type).
- Save each attachment under `<cwd>/.claude-bridge/uploads/` where `cwd` is the
  attached session's current working directory.
- Reply in Telegram with the saved **path relative to cwd** plus the byte size.
- Be robust: friendly messages when not attached, on download failure, and for
  files larger than the Telegram Bot API limit.

## Non-goals

- No auto-prompting Claude / typing into the TUI (caption is ignored for now).
- No sending files *out* from Claude to Telegram (that is a separate feature;
  it needs multipart upload).
- No automatic edits to the user's repo (e.g. touching their `.gitignore`).

## Decisions (from brainstorming)

| Question | Decision |
|---|---|
| What to do after saving | Save only + reply with the path; do not touch the Claude session. |
| Which attachment types | Both compressed photos and arbitrary documents. |
| Where to save | `<cwd>/.claude-bridge/uploads/` (subfolder under the session cwd). |
| Code structure | Approach A — extend `telegram.ts`, add a focused `lib/attachments.ts`, wire into `dispatcher.ts`. |
| How to get cwd | Fetch fresh via `tmux.paneCwd(session)` at save time (no `AttachedSession`/`daemon.ts` change). |

## Architecture

Three units, each with one purpose.

### 1. `lib/telegram.ts` (extend)

New types:

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

Extend `TelegramMessage` with: `photo?: PhotoSize[]`, `document?: Document`,
`caption?: string`.

New `TelegramClient` methods:

- `getFile(fileId: string): Promise<TelegramFile>` — calls the existing
  `request()` helper (`POST /bot<token>/getFile`), returns the `File` object
  whose `file_path` is needed to download.
- `downloadFile(filePath: string): Promise<Buffer>` — a **new** binary `https.get`
  helper (the existing `request()` POSTs JSON to `/bot<token>/<method>`; the file
  endpoint is a different path and returns raw bytes). It GETs
  `https://api.telegram.org/file/bot<token>/<filePath>`, concatenates response
  `Buffer`s, enforces a request timeout, and rejects on non-2xx status.

### 2. `lib/attachments.ts` (new — pure logic + orchestration)

```ts
// Decide which attachment (if any) the message carries.
export function pickAttachment(msg: TelegramMessage):
    { fileId: string; suggestedName: string; fileSize?: number } | null
```
- `msg.document` → `fileId = document.file_id`,
  `suggestedName = document.file_name ?? \`file-${document.file_unique_id}\``,
  `fileSize = document.file_size`.
- else `msg.photo` (non-empty) → pick the **largest** size (max `width*height`,
  in practice the last element), `suggestedName = \`photo-${file_unique_id}.jpg\``.
- else → `null`.

```ts
// Make a filename safe to write inside uploads/ — no path escape.
export function sanitizeName(name: string): string
```
- Take the basename only, strip control chars, collapse to `[A-Za-z0-9._-]`
  (replacing other runs with `_`), trim leading dots/separators, and fall back
  to `file` if the result is empty. Pure → unit-testable.

```ts
// Resolve a non-colliding absolute path inside dir for the given name.
export async function resolveTarget(dir: string, name: string): Promise<string>
```
- If `<dir>/<name>` is free, return it. Otherwise insert `-1`, `-2`, … before
  the extension until free.

```ts
// Orchestrate: download via tg, write into <cwd>/.claude-bridge/uploads,
// return the path relative to cwd plus the byte count.
export async function saveAttachment(
    tg: Pick<TelegramClient, 'getFile' | 'downloadFile'>,
    fileId: string,
    suggestedName: string,
    cwd: string,
): Promise<{ relPath: string; bytes: number }>
```
- `const file = await tg.getFile(fileId)`; if `!file.file_path` → throw.
- `const buf = await tg.downloadFile(file.file_path)`.
- `const dir = path.join(cwd, '.claude-bridge', 'uploads')`;
  `await fs.mkdir(dir, { recursive: true })`.
- `const target = await resolveTarget(dir, sanitizeName(suggestedName))`.
- `await fs.writeFile(target, buf)`.
- return `{ relPath: path.relative(cwd, target), bytes: buf.length }`.

The 20 MB pre-check lives in the dispatcher (it has the `fileSize` from
`pickAttachment` and owns the user-facing message), so `saveAttachment` stays a
plain download-and-write.

### 3. `lib/dispatcher.ts` (modify `routeMessage`)

Insert, **after** the allow/thread checks and **before** `const text = …`
(a photo-only message has no text and would otherwise hit `if (!text) return`):

```ts
const att = pickAttachment(msg)
if (att) { await handleAttachment(att, ctx); return }
```

New local helper `handleAttachment(att, ctx)`:
- If `!ctx.state.attached` → reply
  `⚠️ Chưa attach session nào — không biết lưu vào đâu. Dùng /attach trước.`; return.
- If `att.fileSize && att.fileSize > 20 * 1024 * 1024` → reply
  `❌ File quá lớn (>20MB) — Telegram bot không tải được.`; return.
- `const cwd = await tmux.paneCwd(session)` (on throw → reply
  `❌ Không lấy được thư mục làm việc: <errMsg>`; return).
- `try { const { relPath, bytes } = await saveAttachment(ctx.tg, att.fileId, att.suggestedName, cwd);`
  reply ``📎 Đã lưu `\<relPath\>` (\<KB\> KB). Tham chiếu path này cho Claude khi cần.``
  `} catch (e) { reply ❌ Lưu file thất bại: <errMsg> }`.
- `relPath` is rendered inside inline-code backticks, so underscores in the
  filename are literal and safe under the default `Markdown` parse mode.

## Data flow

```
update (photo|document)
  → routeUpdate → routeMessage
    → pickAttachment(msg)              (lib/attachments)
    → handleAttachment(att, ctx)       (lib/dispatcher)
        → tmux.paneCwd(session)        (lib/tmux)
        → saveAttachment(...)          (lib/attachments)
            → tg.getFile(fileId)       (lib/telegram)
            → tg.downloadFile(path)    (lib/telegram)
            → fs.mkdir + fs.writeFile
    → tg.sendMessage(path reply)
```

No changes to `daemon.ts` or `AttachedSession`.

## Error handling / edge cases

- **Not attached** → friendly warning, no download.
- **`paneCwd` fails** → error reply, no download.
- **File > 20 MB** → blocked before download when `file_size` is known (Bot API
  `getFile` only serves files ≤ 20 MB). When `file_size` is absent, rely on the
  `getFile`/download error path, surfaced via the generic failure reply.
- **Path traversal** → `sanitizeName` (basename + allowlist) plus `resolveTarget`
  confine writes to `uploads/`; a malicious `file_name` cannot escape.
- **Album / multiple photos** → Telegram delivers each as its own update →
  one save + one reply per file. Acceptable.
- **`caption`** → ignored for now; reserved as a hook for a future
  auto-prompt-to-Claude mode.

## Security

- Reuses the existing allow-list (`isAllowed`) and thread (`isCorrectThread`)
  gates — unauthorized users/threads never reach `handleAttachment`.
- Writes are confined to `<cwd>/.claude-bridge/uploads/`.

## Testing (mini-runner, no network)

`test/attachments.test.ts`:
- `sanitizeName`: strips `../` and path separators, removes control chars,
  keeps `a_b-c.PNG`, empty/garbage → `file` fallback.
- `pickAttachment`: document → its `file_id` + name; photo array → largest size;
  neither → `null`; caption does not affect selection.
- `resolveTarget`: collisions resolve to `-1`, `-2` (uses a temp dir under
  `os.tmpdir()`).
- `saveAttachment`: with a **fake `tg`** (`getFile` returns `{ file_path }`,
  `downloadFile` returns a `Buffer`) writes into a temp cwd; asserts the file
  exists with the right bytes and `relPath` equals
  `.claude-bridge/uploads/<name>`.

Add `dist/test/attachments.test.js` to the `test` script in `package.json`.

The dispatcher `handleAttachment` path is not unit-tested here (it shells out to
`tmux.paneCwd`, which the existing dispatcher tests deliberately avoid mocking).

## Project-constraint adherence

- **Zero runtime deps:** download uses Node's built-in `https`; no new packages.
- **Node 14+:** no Node 16+ APIs; `Buffer.concat`, `fs/promises`, `https.get`
  are all available.
- **ESM NodeNext:** internal imports keep the `.js` extension.
- **Strict TS:** all new types explicit.
- **Single process:** no new long-lived resources; downloads are one-shot.

## Future hooks (out of scope now)

- Use `caption` as a prompt and type `caption + path` into the session
  (the "send into Claude" hand-off we deferred).
- Sending files *out* from Claude to Telegram (`sendDocument`, multipart).
