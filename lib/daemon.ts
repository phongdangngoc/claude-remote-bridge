import path from 'path'
import { spawn } from 'child_process'
import { TelegramClient, isRateLimit, isInvalidToken, isNotModified, isTooOldToEdit, escapeHtml, TelegramError } from './telegram.js'
import * as tmux from './tmux.js'
import * as fifo from './fifo.js'
import { Streamer, Sink } from './streamer.js'
import { detectPrompt, Option, PromptResult } from './parser.js'
import { routeUpdate, BridgeState, Ctx } from './dispatcher.js'
import { loadConfig, loadState, saveState, getFifoDir } from './config.js'
import { errMsg } from './errors.js'

type LogLevel = 'info' | 'warn' | 'error'

function log(level: LogLevel, actor: string, msg: string): void {
    process.stderr.write(`[${level}] [${actor}] ${msg}\n`)
}

function gitBranch(cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], { stdio: ['ignore', 'pipe', 'pipe'] })
        let out = ''
        child.stdout!.on('data', (d: Buffer) => out += d.toString())
        child.on('error', reject)
        child.on('close', (code) => code === 0 ? resolve(out.trim()) : reject(new Error(`git exit ${code}`)))
    })
}

// Trim a tmux pane capture down to the latest user turn: drop the host /
// status footer and everything above the most recent `❯ <user message>`
// line. The result is approximately "what's new since the user's last
// message" — the question they asked plus Claude's reply, minus prior
// history and the bottom status bar.
//
// Fails-soft: if neither marker is found, the original text is returned so
// the snapshot still goes through (some pane states won't match the
// heuristics — better a noisy frame than a blank one).
export function trimToLatestTurn(text: string): string {
    const lines = text.split('\n')

    // Find the status footer. Claude Code prints a host line containing
    // `Session: <uuid>` plus 3-4 stats lines; it may be preceded by a
    // separator (─/━/═) and blank lines that should also be dropped.
    let footerStart = lines.length
    for (let i = 0; i < lines.length; i++) {
        if (/Session:\s+[0-9a-f-]{8,}/i.test(lines[i])) {
            footerStart = i
            while (footerStart > 0 && (/^[\s─━═]+$/.test(lines[footerStart - 1]) || lines[footerStart - 1].trim() === '')) {
                footerStart--
            }
            break
        }
    }

    // Walk backwards from the footer for the last user-input cursor line.
    // Numbered menu rows (`❯ 1. ...`) are cursor lines too, so exclude them.
    let userLineIdx = -1
    for (let i = footerStart - 1; i >= 0; i--) {
        if (/^\s*[❯►>]\s+\S/.test(lines[i]) && !/^\s*[❯►>]\s+\d+\.\s/.test(lines[i])) {
            userLineIdx = i
            break
        }
    }

    const sliced = userLineIdx >= 0
        ? lines.slice(userLineIdx, footerStart)
        : lines.slice(0, footerStart)

    // Trim trailing input-prompt artifacts: the empty `❯` cursor line, the
    // separator rules that bracket it, and any blank padding. Without this
    // every snapshot ends with an empty cursor + ─── that isn't part of the
    // response. Menu states still match (the menu's "Enter to select…"
    // footer isn't an empty cursor) so they're preserved.
    let endIdx = sliced.length
    while (endIdx > 0) {
        const last = sliced[endIdx - 1]
        if (/^\s*[❯►>][\s▌█▏]*$/.test(last) || /^[\s─━═]+$/.test(last) || last.trim() === '') {
            endIdx--
        } else {
            break
        }
    }
    return sliced.slice(0, endIdx).join('\n')
}

// Collapse a trimmed turn into the form shown in chat: strip trailing spaces,
// squeeze blank runs, drop leading/trailing blank lines.
export function cleanTurn(captured: string): string {
    return trimToLatestTurn(captured)
        .replace(/[ \t]+$/gm, '')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/^\n+|\n+$/g, '')
}

// How many lines at the bottom of a capture count as the status/input
// region — where Claude Code's spinner and "esc to interrupt" hint render.
const STATUS_REGION_LINES = 12

// Did the pane reach an input boundary? "Settled" means Claude has yielded
// control back to the user — either by finishing a response (idle prompt)
// or by surfacing an approve/menu prompt. The empty `❯` cursor at the
// bottom alone isn't enough: it's present even before Claude has begun to
// respond, so we also require the absence of an active spinner status AND
// the presence of a Claude-emitted content indicator (response bullet or
// tool-call glyph) between the user's last input line and the footer.
export function paneIsSettled(captured: string, prompt: PromptResult): boolean {
    if (prompt.type === 'approve' || prompt.type === 'menu') return true

    // "Still generating" signals live only in the bottom status/input region.
    // Scoping the scan there (rather than the whole capture) stops innocuous
    // response *content* — e.g. the literal words "ran for 5 s" or a stray
    // braille glyph in a code block — from wedging the turn as never-settled.
    const lines = captured.split('\n')
    const statusRegion = lines.slice(-STATUS_REGION_LINES).join('\n')
    //   • "esc to interrupt" is Claude Code's most reliable in-progress marker
    //   • ✶✻✽… / braille ⠋⠙… are spinner frames
    // Deliberately NOT matching gerund-plus-timer text ("waiting for 30 s"):
    // that phrasing appears in ordinary answers and used to wedge the turn as
    // permanently unsettled.
    if (/esc to interrupt/i.test(statusRegion)) return false
    if (/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⠟⠷⠿✶✻✽✳✺✷✦]/.test(statusRegion)) return false

    let searchEnd = lines.length
    for (let i = 0; i < lines.length; i++) {
        if (/Session:\s+[0-9a-f-]{8,}/i.test(lines[i])) { searchEnd = i; break }
    }

    // Require that Claude has actually produced content after the user's
    // last input. The response bullet `●` covers normal answers; `⏺` and
    // `⎿` cover tool invocations and their output continuations.
    let userLineIdx = -1
    for (let i = searchEnd - 1; i >= 0; i--) {
        if (/^\s*[❯►>]\s+\S/.test(lines[i]) && !/^\s*[❯►>]\s+\d+\.\s/.test(lines[i])) {
            userLineIdx = i
            break
        }
    }
    if (userLineIdx >= 0) {
        let hasResponse = false
        for (let i = userLineIdx + 1; i < searchEnd; i++) {
            if (/^\s*[●⏺⎿]/.test(lines[i])) { hasResponse = true; break }
        }
        if (!hasResponse) return false
    }

    // Empty input cursor sitting just above the status footer = idle.
    for (let i = Math.max(0, searchEnd - 5); i < searchEnd; i++) {
        if (/^\s*[❯►>][\s▌█▏]*$/.test(lines[i])) return true
    }
    return false
}

// Build the per-message header. Fails-soft: any missing piece is dropped.
async function buildHeader(session: string, cwd: string | undefined): Promise<string> {
    const parts = [`📡 \`${session}\``]
    if (cwd) {
        parts.push(`\`${path.basename(cwd)}\``)
        try {
            const branch = await gitBranch(cwd)
            if (branch && branch !== 'HEAD') parts.push(`\`${branch}\``)
        } catch {}
    }
    return parts.join(' · ')
}

export async function runDaemon(): Promise<void> {
    const config = await loadConfig()
    const state = await loadState()
    const tg = new TelegramClient(config.bot_token, {
        defaultThreadId: config.thread_id ? Number(config.thread_id) : null,
    })
    const fifoDir = getFifoDir(config)
    await fifo.ensureFifoDir(fifoDir)

    // Defensive: clear any webhook so getUpdates works
    try {
        await tg.deleteWebhook()
    } catch (e) {
        log('warn', 'telegram', `deleteWebhook failed: ${errMsg(e)}`)
        if (isInvalidToken(e)) {
            log('error', 'telegram', 'Invalid bot token. Run: node dist/bridge.js init')
            process.exit(78)  // EX_CONFIG
        }
    }

    const bridgeState: BridgeState = {
        attached: null,
        startedAt: Date.now(),
        lastFifoByteAt: 0,
        errorsLastHour: 0,
    }

    let lastUpdateId = state.last_update_id ?? 0

    async function attach(sessionName: string): Promise<void> {
        if (bridgeState.attached) {
            await detach()
        }
        const fifoPath = fifo.fifoPathFor(fifoDir, sessionName)
        await fifo.createFifo(fifoPath)
        // Open read stream BEFORE pipe-pane (so cat doesn't block on open)
        const stream = fifo.openReadStream(fifoPath)
        try {
            await tmux.pipePaneStart(sessionName, `cat > ${JSON.stringify(fifoPath)}`)
        } catch (e) {
            // pipe-pane failed: tear down the half-open attachment so the
            // O_RDWR fd and the FIFO file don't leak. bridgeState.attached
            // isn't set yet, so detach() can't reclaim them.
            stream.destroy()
            await fifo.unlinkFifo(fifoPath).catch(() => {})
            throw e
        }

        // Cache cwd at attach time. Header on every new send re-queries the
        // git branch (cheap) but reuses the cached cwd.
        let cachedCwd: string | undefined
        try { cachedCwd = await tmux.paneCwd(sessionName) } catch (e) {
            log('warn', 'tmux', `paneCwd failed: ${errMsg(e)}`)
        }

        // Snapshot-on-settle: raw FIFO bytes are only an activity signal.
        // Once the pane has been quiet for `silence_ms` AND we can tell
        // Claude is back at an input boundary (idle prompt or approve/menu
        // prompt visible), we send one snapshot as a fresh Telegram message.
        // No edits — each turn produces exactly one persistent message in
        // chat history, so scrolling back gives a clean transcript.
        let lastPromptKey: string | null = null
        // Body currently shown in the per-turn snapshot message, and the last
        // body that Telegram rejected — so a second settle in the same turn
        // edits in place (instead of dropping later output), and a payload the
        // API keeps refusing isn't re-POSTed every silence tick.
        let lastSnapshotBody: string | null = null
        let lastFailedBody: string | null = null
        // Turn already on screen at attach time. After a daemon restart the
        // pane is usually already settled; suppress re-posting that exact turn
        // (the user saw it before the restart) until something new appears.
        let initialCleaned: string | null = null
        try {
            const at = await tmux.capturePane(sessionName, { lines: config.snapshot_lines })
            const c = cleanTurn(at)
            if (c && paneIsSettled(at, detectPrompt(c))) initialCleaned = c
        } catch { /* best effort */ }
        const getSnapId = (): number | null => bridgeState.attached?.snapshotMessageId ?? null
        const setSnapId = (id: number | null): void => {
            if (bridgeState.attached) bridgeState.attached.snapshotMessageId = id
        }

        async function sendSnapshot(): Promise<void> {
            let captured: string
            try {
                captured = await tmux.capturePane(sessionName, { lines: config.snapshot_lines })
            } catch (e) {
                log('warn', 'snapshot', `capturePane failed: ${errMsg(e)}`)
                return
            }
            const cleaned = cleanTurn(captured)
            const prompt = detectPrompt(cleaned)

            // Only act once Claude has reached an input boundary. Mid-thought
            // pauses (Claude waiting on its own API call) shouldn't produce
            // intermediate snapshots — wait for the real settle.
            const settled = paneIsSettled(captured, prompt)
            if (settled && cleaned) {
                let header = ''
                try { header = await buildHeader(sessionName, cachedCwd) } catch {}
                // Reserve headroom so header + code fence + truncation marker
                // can't push the message past Telegram's 4096-char hard cap.
                const HARD_LIMIT = 4096
                const reserve = header.length + 32
                const max = Math.max(256, Math.min(config.max_message_chars, HARD_LIMIT - reserve))
                const trimmed = cleaned.length > max ? '[…truncated…]\n' + cleaned.slice(-max) : cleaned
                const fenced = '```\n' + trimmed.replace(/```/g, '``​`') + '\n```'
                const body = header ? `${header}\n${fenced}` : fenced

                const id = getSnapId()
                if (id == null) {
                    // First settle of the turn → fresh message. Skip the turn
                    // already on screen at attach time, and any body the API has
                    // already rejected (don't hammer it).
                    if (cleaned === initialCleaned) {
                        // already shown before restart — nothing new yet
                    } else if (body !== lastFailedBody) {
                        try {
                            const msg = await tg.sendMessage(config.chat_id, body)
                            setSnapId(msg.message_id)
                            lastSnapshotBody = body
                            lastFailedBody = null
                            initialCleaned = null
                            // Buttons (if any) belong under the fresh message.
                            lastPromptKey = null
                            log('info', 'snapshot', `sendNew msgId=${msg.message_id} bodyLen=${body.length}`)
                        } catch (e) {
                            lastFailedBody = body
                            log('warn', 'telegram', errMsg(e))
                        }
                    }
                } else if (body !== lastSnapshotBody) {
                    // Same turn, new content (tool output, the final answer) —
                    // edit the persistent message in place so nothing is lost.
                    lastSnapshotBody = body
                    try {
                        await tg.editMessageText(config.chat_id, id, body)
                        log('info', 'snapshot', `edit msgId=${id} bodyLen=${body.length}`)
                    } catch (e) {
                        if (isNotModified(e)) {
                            // no-op
                        } else if (isTooOldToEdit(e)) {
                            try {
                                const msg = await tg.sendMessage(config.chat_id, body)
                                setSnapId(msg.message_id)
                                lastPromptKey = null
                            } catch (e2) { log('warn', 'telegram', errMsg(e2)) }
                        } else {
                            log('warn', 'telegram', errMsg(e))
                        }
                    }
                }
            }

            // Buttons + prompt state only matter at a genuine input boundary.
            if (!settled) return
            if (prompt.type === 'approve') {
                const key = 'a|' + prompt.options.map(o => `${o.index}:${o.label}`).join('|')
                if (key !== lastPromptKey) {
                    lastPromptKey = key
                    await sendApproveButtons(prompt.options)
                    log('info', 'snapshot', `sent approve buttons (${prompt.options.length})`)
                }
                if (bridgeState.attached) {
                    bridgeState.attached.lastPromptOptions = prompt.options
                    bridgeState.attached.lastPromptType = 'approve'
                }
            } else if (prompt.type === 'menu') {
                const key = 'm|' + prompt.options.map(o => `${o.index}:${o.label}:${o.selected ? '*' : ''}`).join('|')
                if (key !== lastPromptKey) {
                    lastPromptKey = key
                    await sendMenuButtons(prompt.options)
                    log('info', 'snapshot', `sent menu buttons (${prompt.options.length})`)
                }
                if (bridgeState.attached) {
                    const idx = prompt.options.findIndex(o => o.selected)
                    bridgeState.attached.menuCursor = idx < 0 ? 0 : idx
                    bridgeState.attached.lastPromptOptions = prompt.options
                    bridgeState.attached.lastPromptType = 'menu'
                }
            } else {
                lastPromptKey = null
                if (bridgeState.attached) {
                    bridgeState.attached.lastPromptOptions = null
                    bridgeState.attached.lastPromptType = null
                }
            }
        }

        const sink: Sink = {
            sendNew: async () => -1,
            edit: async () => {},
            onSilence: async () => {
                try { await sendSnapshot() } catch (e) {
                    log('warn', 'snapshot', errMsg(e))
                }
            },
            onError: (e: Error) => {
                bridgeState.errorsLastHour++
                log('warn', 'streamer', e.message)
            },
        }

        const streamer = new Streamer(sink, {
            silenceMs: config.silence_ms,
            editThrottleMs: config.edit_throttle_ms,
            maxMessageChars: config.max_message_chars,
        })

        stream.on('data', (chunk: string | Buffer) => {
            bridgeState.lastFifoByteAt = Date.now()
            streamer.push(chunk)
        })
        stream.on('error', (e: Error) => log('warn', 'fifo', e.message))
        stream.on('end', () => log('info', 'fifo', `EOF on ${fifoPath}`))

        bridgeState.attached = {
            session: sessionName, fifoPath, stream, streamer,
            menuCursor: 0, snapshotMessageId: null,
            lastPromptOptions: null, lastPromptType: null,
        }
        state.attached_session = sessionName
        await saveState({ ...state, attached_session: sessionName })
        log('info', 'attach', `attached to ${sessionName}`)
    }

    async function detach(): Promise<void> {
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

    async function sendApproveButtons(options: Option[]): Promise<void> {
        const lines = ['👇 <b>Approve prompt:</b>', '']
        options.forEach((o, i) => lines.push(`<b>${i + 1}.</b> ${escapeHtml(o.label)}`))
        const inline = options.map((o, i) => ({
            text: String(i + 1),
            callback_data: `approve:${o.index}`,
        }))
        await tg.sendMessage(config.chat_id, lines.join('\n'), {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [inline] },
        })
    }

    async function sendMenuButtons(options: Option[]): Promise<void> {
        // Claude Code "escape hatch" options need different UX: tapping them
        // doesn't pick a quiz answer, it switches the menu into free-text /
        // free-chat mode. Rename them so users understand, and tag callback
        // data so dispatcher can send a follow-up hint after pressing them.
        const specialize = (label: string): { kind: 't' | 'c' | null; display: string } => {
            if (/^type something\.?$/i.test(label)) return { kind: 't', display: '📝 Trả lời tự do' }
            if (/^chat about this$/i.test(label)) return { kind: 'c', display: '💬 Bỏ menu, chat thường' }
            return { kind: null, display: label }
        }
        const limited = options.slice(0, 8)
        const lines = ['👇 <b>Choose an option:</b>', '']
        limited.forEach((o, i) => {
            const s = specialize(o.label)
            lines.push(`<b>${i + 1}.</b> ${escapeHtml(s.display)}`)
        })
        const buttons = limited.map((o, i) => {
            const s = specialize(o.label)
            return {
                text: String(i + 1),
                callback_data: s.kind ? `menu:${i}:${s.kind}` : `menu:${i}`,
            }
        })
        const rows: typeof buttons[] = []
        for (let i = 0; i < buttons.length; i += 4) rows.push(buttons.slice(i, i + 4))
        await tg.sendMessage(config.chat_id, lines.join('\n'), {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: rows },
        })
    }

    async function sendStatus(): Promise<void> { /* delegated to dispatcher cmdStatus */ }

    const ctx: Ctx = {
        state: bridgeState,
        config,
        tg,
        chatId: config.chat_id,
        attach,
        detach,
        sendStatus,
    }

    // Restore attached session if any
    if (state.attached_session) {
        if (await tmux.hasSession(state.attached_session)) {
            try {
                await attach(state.attached_session)
                await tg.sendMessage(config.chat_id, `🔄 Bridge restarted — reattached to \`${state.attached_session}\``)
            } catch (e) {
                log('warn', 'reattach', errMsg(e))
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
    const shutdown = async (signal: string): Promise<void> => {
        if (shuttingDown) return
        shuttingDown = true
        log('info', 'daemon', `received ${signal}, shutting down`)
        await detach().catch(() => {})
        await saveState({ ...state, last_update_id: lastUpdateId, outbound_message_id: null })
        process.exit(0)
    }
    process.on('SIGTERM', () => { void shutdown('SIGTERM') })
    process.on('SIGINT',  () => { void shutdown('SIGINT') })
    process.on('uncaughtException', async (e: Error) => {
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
                    log('error', 'dispatch', `update ${update.update_id}: ${errMsg(e)}`)
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
                const wait = ((e as TelegramError).parameters?.retry_after ?? 5) * 1000
                log('warn', 'telegram', `rate limited, sleeping ${wait}ms`)
                await new Promise(r => setTimeout(r, wait))
                continue
            }
            log('warn', 'telegram', `poll error: ${errMsg(e)}; backoff ${backoff}ms`)
            await new Promise(r => setTimeout(r, backoff))
            backoff = Math.min(backoff * 2, 60000)
        }
    }
}
