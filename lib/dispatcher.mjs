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

// If config.thread_id is set, only accept updates from that forum topic.
// Telegram sets message_thread_id on messages inside a forum topic, and
// callback_query.message inherits it. Missing → top-level (General) chat.
function isCorrectThread(msgOrCb, ctx) {
    const configured = ctx.config.thread_id ? Number(ctx.config.thread_id) : null
    if (configured === null) return true
    const incoming = msgOrCb.message_thread_id ?? msgOrCb.message?.message_thread_id ?? null
    return Number(incoming) === configured
}

async function routeMessage(msg, ctx) {
    if (!isAllowed(msg.from.id, ctx)) return
    if (!isCorrectThread(msg, ctx)) return
    const text = (msg.text ?? '').trim()
    if (!text) return

    if (text.startsWith('/')) {
        return runCommand(text, ctx)
    }
    // Plain text → send to attached session
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
    if (!isCorrectThread(cb, ctx)) {
        return ctx.tg.answerCallbackQuery(cb.id, 'Wrong thread')
    }
    const data = cb.data || ''
    // data formats:
    //   approve:1  → send "1" + Enter
    //   approve:2  → send "2" + Enter
    //   approve:no → send Escape
    //   menu:N     → send Down*N + Enter (N is target index from top, 0-based)
    //   key:Enter|Escape|Up|Down → send special key
    //   confirm:kill:<name> → kill session after confirm
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
