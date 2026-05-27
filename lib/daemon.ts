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

        const sink: Sink = {
            sendNew: async (text: string) => {
                const msg = await tg.sendMessage(config.chat_id, text)
                return msg.message_id
            },
            edit: async (id: number, text: string) => {
                await tg.editMessageText(config.chat_id, id, text)
            },
            onSilence: async (_buf: string) => {
                try {
                    const captured = await tmux.capturePane(sessionName, { lines: config.snapshot_lines })
                    const prompt = detectPrompt(captured)
                    if (prompt.type === 'approve') {
                        await sendApproveButtons(prompt.options)
                    } else if (prompt.type === 'menu') {
                        await sendMenuButtons(prompt.options)
                        if (bridgeState.attached) {
                            const idx = prompt.options.findIndex(o => o.selected)
                            bridgeState.attached.menuCursor = idx < 0 ? 0 : idx
                        }
                    }
                } catch (e) {
                    log('warn', 'parser', `silence handler failed: ${errMsg(e)}`)
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

        bridgeState.attached = { session: sessionName, fifoPath, stream, streamer, menuCursor: 0 }
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
        const inline = options.map(o => ({
            text: o.label.length > 25 ? o.label.slice(0, 22) + '…' : o.label,
            callback_data: `approve:${o.index}`,
        }))
        await tg.sendMessage(config.chat_id, '👇 Approve prompt detected:', {
            reply_markup: { inline_keyboard: [inline] },
        })
    }

    async function sendMenuButtons(options: Option[]): Promise<void> {
        const buttons = options.slice(0, 8).map((o, i) => ({
            text: `${i + 1}. ${o.label.length > 20 ? o.label.slice(0, 17) + '…' : o.label}`,
            callback_data: `menu:${i}`,
        }))
        const rows = []
        for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2))
        await tg.sendMessage(config.chat_id, '👇 Choose an option:', {
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
