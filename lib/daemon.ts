import path from 'path'
import { spawn } from 'child_process'
import { TelegramClient, isRateLimit, isInvalidToken, TelegramError } from './telegram.js'
import * as tmux from './tmux.js'
import * as fifo from './fifo.js'
import { Streamer, Sink } from './streamer.js'
import { detectPrompt, Option } from './parser.js'
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
        await tmux.pipePaneStart(sessionName, `cat > ${JSON.stringify(fifoPath)}`)

        // Cache cwd at attach time. Header on every new send re-queries the
        // git branch (cheap) but reuses the cached cwd.
        let cachedCwd: string | undefined
        try { cachedCwd = await tmux.paneCwd(sessionName) } catch (e) {
            log('warn', 'tmux', `paneCwd failed: ${errMsg(e)}`)
        }

        // Snapshot-on-settle: raw FIFO bytes are only an activity signal.
        // Once the pane has been quiet for `silence_ms`, we send the visible
        // pane content (via tmux capture-pane) as a clean snapshot — this
        // sidesteps the redraw spam from TUIs like Claude Code that animate
        // a spinner/status line and never go truly idle byte-wise.
        let lastSentBody: string | null = null
        let lastEditAt = 0
        let lastPromptKey: string | null = null
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
            const cleaned = captured.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '')
            if (cleaned && (cleaned !== lastSentBody || getSnapId() == null)) {
                let header = ''
                try { header = await buildHeader(sessionName, cachedCwd) } catch {}
                const max = config.max_message_chars
                const trimmed = cleaned.length > max ? '[…truncated…]\n' + cleaned.slice(-max) : cleaned
                const fenced = '```\n' + trimmed.replace(/```/g, '``​`') + '\n```'
                const body = header ? `${header}\n${fenced}` : fenced
                const now = Date.now()
                try {
                    if (getSnapId() == null) {
                        const msg = await tg.sendMessage(config.chat_id, body)
                        setSnapId(msg.message_id)
                        lastEditAt = now
                        lastSentBody = cleaned
                        // Buttons (if any) belong to the previous turn — let
                        // detectPrompt re-emit them under the new message.
                        lastPromptKey = null
                        log('info', 'snapshot', `sendNew msgId=${msg.message_id} bodyLen=${body.length}`)
                    } else if (now - lastEditAt >= config.edit_throttle_ms) {
                        await tg.editMessageText(config.chat_id, getSnapId()!, body)
                        lastEditAt = now
                        lastSentBody = cleaned
                    }
                } catch (e) {
                    const err = e as Error & { code?: number }
                    log('warn', 'telegram', errMsg(err))
                    if (err.code === 400 && /not found|can't be edited|message_id_invalid/i.test(err.message)) {
                        setSnapId(null)
                    }
                }
            }
            const prompt = detectPrompt(cleaned)
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
        const lines = ['👇 *Approve prompt:*', '']
        options.forEach((o, i) => lines.push(`*${i + 1}.* ${o.label}`))
        const inline = options.map((o, i) => ({
            text: String(i + 1),
            callback_data: `approve:${o.index}`,
        }))
        await tg.sendMessage(config.chat_id, lines.join('\n'), {
            parse_mode: 'Markdown',
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
        const lines = ['👇 *Choose an option:*', '']
        limited.forEach((o, i) => {
            const s = specialize(o.label)
            lines.push(`*${i + 1}.* ${s.display}`)
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
            parse_mode: 'Markdown',
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
