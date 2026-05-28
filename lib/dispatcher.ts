import * as tmux from './tmux.js'
import { errMsg } from './errors.js'
import type { Streamer } from './streamer.js'
import type { Config } from './config.js'
import type { TelegramClient, TelegramUpdate, TelegramMessage, TelegramCallbackQuery } from './telegram.js'
import type { ReadStream } from 'fs'
import type { Option } from './parser.js'

export interface AttachedSession {
    session: string
    fifoPath: string
    stream: ReadStream
    streamer: Streamer
    menuCursor: number
    // Null = the next snapshot should start a fresh Telegram message instead
    // of editing the previous one. Set after each user input so each Q&A is
    // its own pinned-at-bottom message thread.
    snapshotMessageId: number | null
    // Options shown in the most recent approve/menu button message, kept so
    // the callback handler can echo back the chosen option's label.
    lastPromptOptions: Option[] | null
    lastPromptType: 'approve' | 'menu' | null
}

export interface BridgeState {
    attached: AttachedSession | null
    startedAt: number
    lastFifoByteAt: number
    errorsLastHour: number
}

export interface Ctx {
    state: BridgeState
    config: Config
    tg: TelegramClient
    chatId: number | string
    attach(name: string): Promise<void>
    detach(): Promise<void>
    sendStatus(): Promise<void>
}

export async function routeUpdate(update: TelegramUpdate, ctx: Ctx): Promise<void> {
    if (update.message) {
        await routeMessage(update.message, ctx)
        return
    }
    if (update.callback_query) {
        await routeCallback(update.callback_query, ctx)
    }
}

function isAllowed(fromId: number, ctx: Ctx): boolean {
    return ctx.config.allowed_chat_ids.map(Number).includes(Number(fromId))
}

// If config.thread_id is set, only accept updates from that forum topic.
// Telegram sets message_thread_id on messages inside a forum topic, and
// callback_query.message inherits it. Missing → top-level (General) chat.
function isCorrectThread(msgOrCb: TelegramMessage | TelegramCallbackQuery, ctx: Ctx): boolean {
    const configured = ctx.config.thread_id ? Number(ctx.config.thread_id) : null
    if (configured === null) return true
    const incoming = (msgOrCb as TelegramMessage).message_thread_id
        ?? (msgOrCb as TelegramCallbackQuery).message?.message_thread_id
        ?? null
    return incoming !== null && Number(incoming) === configured
}

async function routeMessage(msg: TelegramMessage, ctx: Ctx): Promise<void> {
    if (!msg.from) return
    if (!isAllowed(msg.from.id, ctx)) return
    if (!isCorrectThread(msg, ctx)) return
    const text = (msg.text ?? '').trim()
    if (!text) return

    if (text.startsWith('/')) {
        await runCommand(text, ctx)
        return
    }
    if (!ctx.state.attached) {
        await ctx.tg.sendMessage(ctx.chatId, '⚠️ Not attached. Use `/list` then `/attach <name>`.')
        return
    }
    try {
        await tmux.sendKeys(ctx.state.attached.session, text, { literal: true })
        await tmux.sendEnter(ctx.state.attached.session)
        // Start a fresh snapshot message for the response — keeps the latest
        // turn pinned at the bottom of the chat so the user doesn't scroll up.
        ctx.state.attached.snapshotMessageId = null
    } catch (e) {
        await ctx.tg.sendMessage(ctx.chatId, `❌ send-keys failed: ${errMsg(e)}`)
    }
}

async function routeCallback(cb: TelegramCallbackQuery, ctx: Ctx): Promise<void> {
    if (!isAllowed(cb.from.id, ctx)) {
        await ctx.tg.answerCallbackQuery(cb.id, 'Not authorized')
        return
    }
    if (!isCorrectThread(cb, ctx)) {
        await ctx.tg.answerCallbackQuery(cb.id, 'Wrong thread')
        return
    }
    const data = cb.data ?? ''
    // data formats:
    //   approve:1  → send "1" + Enter
    //   approve:no → send Escape
    //   menu:N     → send Down*N + Enter (N is target index from top, 0-based)
    //   key:Enter|Escape|Up|Down → send special key
    //   confirm:kill:<name> → kill session after confirm
    try {
        if (data.startsWith('approve:')) {
            const action = data.slice(8)
            if (!ctx.state.attached) {
                await ctx.tg.answerCallbackQuery(cb.id, 'Not attached')
                return
            }
            if (action === 'no') {
                await tmux.sendSpecialKey(ctx.state.attached.session, 'Escape')
            } else {
                await tmux.sendKeys(ctx.state.attached.session, action, { literal: true })
                await tmux.sendEnter(ctx.state.attached.session)
            }
            await ctx.tg.answerCallbackQuery(cb.id, `Sent: ${action}`)
            const opts = ctx.state.attached.lastPromptOptions
            const picked = action === 'no'
                ? null
                : (opts?.find(o => o.index === Number(action)) ?? null)
            const label = picked
                ? `*${picked.index}.* ${picked.label}`
                : (action === 'no' ? '_no / abort_' : `option ${action}`)
            await ctx.tg.sendMessage(ctx.chatId, `✅ Đã chọn: ${label}`, { parse_mode: 'Markdown' })
        } else if (data.startsWith('menu:')) {
            if (!ctx.state.attached) {
                await ctx.tg.answerCallbackQuery(cb.id, 'Not attached')
                return
            }
            const parts = data.slice(5).split(':')
            const target = Number(parts[0])
            const special = parts[1] // 't' = type-something, 'c' = chat-about-this
            const current = ctx.state.attached.menuCursor ?? 0
            const delta = target - current
            const key = delta >= 0 ? 'Down' : 'Up'
            for (let i = 0; i < Math.abs(delta); i++) {
                await tmux.sendSpecialKey(ctx.state.attached.session, key)
            }
            await tmux.sendEnter(ctx.state.attached.session)
            await ctx.tg.answerCallbackQuery(cb.id, `Selected option ${target + 1}`)
            const opts = ctx.state.attached.lastPromptOptions
            const picked = opts?.[target] ?? null
            const display = special === 't'
                ? '📝 Trả lời tự do'
                : special === 'c'
                    ? '💬 Bỏ menu, chat thường'
                    : (picked?.label ?? `option ${target + 1}`)
            await ctx.tg.sendMessage(ctx.chatId, `✅ Đã chọn: *${target + 1}.* ${display}`, { parse_mode: 'Markdown' })
            if (special === 't') {
                await ctx.tg.sendMessage(ctx.chatId, '📝 Giờ gõ câu trả lời tự do trong chat này, bridge sẽ chuyển vào Claude.')
            } else if (special === 'c') {
                await ctx.tg.sendMessage(ctx.chatId, '💬 Đã thoát menu. Cứ chat bình thường — tin nhắn sẽ vào Claude.')
            }
        } else if (data.startsWith('key:')) {
            if (!ctx.state.attached) {
                await ctx.tg.answerCallbackQuery(cb.id, 'Not attached')
                return
            }
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
        await ctx.tg.answerCallbackQuery(cb.id, `Error: ${errMsg(e)}`.slice(0, 200))
    }
}

async function runCommand(text: string, ctx: Ctx): Promise<void> {
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
            await ctx.tg.sendMessage(ctx.chatId, `Unknown command: \`${cmd}\`. Try /help.`)
    }
}

async function cmdHelp(ctx: Ctx): Promise<void> {
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

async function cmdList(ctx: Ctx): Promise<void> {
    const sessions = await tmux.listSessions()
    if (sessions.length === 0) {
        await ctx.tg.sendMessage(ctx.chatId, '_No tmux sessions running._\nStart one with `tmux new -d -s <name> "claude"`')
        return
    }
    const lines = sessions.map(s => {
        const marker = ctx.state.attached?.session === s.name ? '📡 ' : '   '
        const att = s.attached ? ' (local-attached)' : ''
        return `${marker}\`${s.name}\` — ${s.windows} window(s)${att}`
    })
    await ctx.tg.sendMessage(ctx.chatId, lines.join('\n'))
}

async function cmdAttach(name: string | undefined, ctx: Ctx): Promise<void> {
    if (!name) { await ctx.tg.sendMessage(ctx.chatId, 'Usage: `/attach <session-name>`'); return }
    if (!(await tmux.hasSession(name))) {
        const sessions = await tmux.listSessions()
        const list = sessions.map(s => `\`${s.name}\``).join(', ') || '(none)'
        await ctx.tg.sendMessage(ctx.chatId, `Session \`${name}\` not found.\nAvailable: ${list}`)
        return
    }
    try {
        await ctx.attach(name)
        await ctx.tg.sendMessage(ctx.chatId, `📡 Attached to \`${name}\`. Send messages to chat with Claude.`)
    } catch (e) {
        await ctx.tg.sendMessage(ctx.chatId, `❌ Attach failed: ${errMsg(e)}`)
    }
}

async function cmdDetach(ctx: Ctx): Promise<void> {
    if (!ctx.state.attached) {
        await ctx.tg.sendMessage(ctx.chatId, '_Not attached._')
        return
    }
    const name = ctx.state.attached.session
    await ctx.detach()
    await ctx.tg.sendMessage(ctx.chatId, `🔌 Detached from \`${name}\`. Session still running.`)
}

async function cmdStatus(ctx: Ctx): Promise<void> {
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

async function cmdNew(name: string | undefined, ctx: Ctx): Promise<void> {
    if (!name) { await ctx.tg.sendMessage(ctx.chatId, 'Usage: `/new <session-name>`'); return }
    if (await tmux.hasSession(name)) {
        await ctx.tg.sendMessage(ctx.chatId, `Session \`${name}\` already exists. Use /attach.`)
        return
    }
    try {
        await tmux.newSession(name)
        await ctx.tg.sendMessage(ctx.chatId, `🆕 Created \`${name}\`. Attaching...`)
        await ctx.attach(name)
    } catch (e) {
        await ctx.tg.sendMessage(ctx.chatId, `❌ Create failed: ${errMsg(e)}`)
    }
}

async function cmdKill(name: string | undefined, ctx: Ctx): Promise<void> {
    if (!name) { await ctx.tg.sendMessage(ctx.chatId, 'Usage: `/kill <session-name>`'); return }
    if (!(await tmux.hasSession(name))) {
        await ctx.tg.sendMessage(ctx.chatId, `Session \`${name}\` does not exist.`)
        return
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

async function cmdRaw(text: string, ctx: Ctx): Promise<void> {
    if (!ctx.state.attached) {
        await ctx.tg.sendMessage(ctx.chatId, '_Not attached._')
        return
    }
    if (!text) { await ctx.tg.sendMessage(ctx.chatId, 'Usage: `/raw <text>` (sends without Enter)'); return }
    await tmux.sendKeys(ctx.state.attached.session, text, { literal: true })
    await ctx.tg.sendMessage(ctx.chatId, `Sent (no Enter): \`${text.slice(0, 100)}\``)
}
