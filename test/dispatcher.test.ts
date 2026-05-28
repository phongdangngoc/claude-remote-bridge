import { test } from './_runner.js'
import { strict as assert } from 'assert'
import { routeUpdate, Ctx, BridgeState } from '../lib/dispatcher.js'
import type { Config } from '../lib/config.js'
import type { TelegramClient, TelegramUpdate, TelegramMessage } from '../lib/telegram.js'

// Tests cover the routing surface that doesn't shell out to tmux:
//   - allowlist filter
//   - thread filter
//   - "not attached" early-returns
//   - unknown command + unknown callback
//   - /help, /status, /detach replies
// Commands that call tmux (/list, /attach, /new, /kill, /raw, plain text)
// are not covered here — they need a tmux process mock that the dispatcher
// imports statically.

interface SendCall { chatId: number | string; text: string }
interface AnswerCall { id: string; text?: string }

interface FakeTg {
    sends: SendCall[]
    answers: AnswerCall[]
    client: TelegramClient
}

function makeFakeTg(): FakeTg {
    const sends: SendCall[] = []
    const answers: AnswerCall[] = []
    const client = {
        sendMessage: async (chatId: number | string, text: string) => {
            sends.push({ chatId, text })
            return { message_id: sends.length, chat: { id: Number(chatId), type: 'private' }, date: 0 }
        },
        answerCallbackQuery: async (id: string, text?: string) => {
            answers.push({ id, text })
            return true
        },
    } as unknown as TelegramClient
    return { sends, answers, client }
}

function makeCtx(overrides: { thread_id?: number; attached?: boolean } = {}): { ctx: Ctx; tg: FakeTg } {
    const tg = makeFakeTg()
    const state: BridgeState = {
        attached: overrides.attached
            ? { session: 's1', fifoPath: '/tmp/s1.fifo', stream: {} as never, streamer: {} as never, menuCursor: 0, snapshotMessageId: null }
            : null,
        startedAt: 0,
        lastFifoByteAt: 0,
        errorsLastHour: 0,
    }
    const config: Config = {
        silence_ms: 800,
        edit_throttle_ms: 1500,
        max_message_chars: 4000,
        snapshot_lines: 50,
        cursor_chars: ['❯'],
        fifo_dir: '/tmp',
        bot_token: 'x',
        chat_id: 100,
        allowed_chat_ids: [100],
        thread_id: overrides.thread_id,
    }
    const ctx: Ctx = {
        state,
        config,
        tg: tg.client,
        chatId: 100,
        attach: async () => {},
        detach: async () => {},
        sendStatus: async () => {},
    }
    return { ctx, tg }
}

function msg(opts: { fromId?: number; text?: string; thread_id?: number } = {}): TelegramUpdate {
    return {
        update_id: 1,
        message: {
            message_id: 1,
            from: { id: opts.fromId ?? 100, is_bot: false },
            chat: { id: 100, type: 'private' },
            date: 0,
            text: opts.text,
            message_thread_id: opts.thread_id,
        } as TelegramMessage,
    }
}

function cb(opts: { fromId?: number; data?: string; thread_id?: number } = {}): TelegramUpdate {
    return {
        update_id: 1,
        callback_query: {
            id: 'cbq1',
            from: { id: opts.fromId ?? 100, is_bot: false },
            data: opts.data,
            message: opts.thread_id !== undefined
                ? { message_id: 1, chat: { id: 100, type: 'private' }, date: 0, message_thread_id: opts.thread_id } as TelegramMessage
                : undefined,
        },
    }
}

test('dispatcher: drops messages from disallowed users (no reply)', async () => {
    const { ctx, tg } = makeCtx()
    await routeUpdate(msg({ fromId: 999, text: '/help' }), ctx)
    assert.equal(tg.sends.length, 0)
})

test('dispatcher: drops messages from wrong thread when thread_id configured', async () => {
    const { ctx, tg } = makeCtx({ thread_id: 42 })
    await routeUpdate(msg({ text: '/help', thread_id: 7 }), ctx)
    assert.equal(tg.sends.length, 0)
})

test('dispatcher: accepts messages from configured thread', async () => {
    const { ctx, tg } = makeCtx({ thread_id: 42 })
    await routeUpdate(msg({ text: '/help', thread_id: 42 }), ctx)
    assert.equal(tg.sends.length, 1)
})

test('dispatcher: /help renders command list', async () => {
    const { ctx, tg } = makeCtx()
    await routeUpdate(msg({ text: '/help' }), ctx)
    assert.equal(tg.sends.length, 1)
    assert.match(tg.sends[0].text, /\/list/)
    assert.match(tg.sends[0].text, /\/attach/)
})

test('dispatcher: /help shows attached session when present', async () => {
    const { ctx, tg } = makeCtx({ attached: true })
    await routeUpdate(msg({ text: '/help' }), ctx)
    assert.match(tg.sends[0].text, /Currently attached to.*s1/)
})

test('dispatcher: unknown command returns hint', async () => {
    const { ctx, tg } = makeCtx()
    await routeUpdate(msg({ text: '/foo' }), ctx)
    assert.equal(tg.sends.length, 1)
    assert.match(tg.sends[0].text, /Unknown command/)
})

test('dispatcher: plain text without attach returns "Not attached"', async () => {
    const { ctx, tg } = makeCtx()
    await routeUpdate(msg({ text: 'hello' }), ctx)
    assert.equal(tg.sends.length, 1)
    assert.match(tg.sends[0].text, /Not attached/)
})

test('dispatcher: /detach without attach returns "Not attached"', async () => {
    const { ctx, tg } = makeCtx()
    await routeUpdate(msg({ text: '/detach' }), ctx)
    assert.match(tg.sends[0].text, /Not attached/)
})

test('dispatcher: /status reports uptime + no-attach', async () => {
    const { ctx, tg } = makeCtx()
    await routeUpdate(msg({ text: '/status' }), ctx)
    assert.match(tg.sends[0].text, /Bridge status/)
    assert.match(tg.sends[0].text, /Attached.*none/)
})

test('dispatcher: /raw without attach returns "Not attached"', async () => {
    const { ctx, tg } = makeCtx()
    await routeUpdate(msg({ text: '/raw hello' }), ctx)
    assert.match(tg.sends[0].text, /Not attached/)
})

test('dispatcher: empty message is ignored', async () => {
    const { ctx, tg } = makeCtx()
    await routeUpdate(msg({ text: '   ' }), ctx)
    assert.equal(tg.sends.length, 0)
})

test('dispatcher: callback from disallowed user → "Not authorized"', async () => {
    const { ctx, tg } = makeCtx()
    await routeUpdate(cb({ fromId: 999, data: 'approve:1' }), ctx)
    assert.equal(tg.answers.length, 1)
    assert.equal(tg.answers[0].text, 'Not authorized')
})

test('dispatcher: callback from wrong thread → "Wrong thread"', async () => {
    const { ctx, tg } = makeCtx({ thread_id: 42 })
    await routeUpdate(cb({ data: 'approve:1', thread_id: 7 }), ctx)
    assert.equal(tg.answers[0].text, 'Wrong thread')
})

test('dispatcher: approve callback without attach → "Not attached"', async () => {
    const { ctx, tg } = makeCtx()
    await routeUpdate(cb({ data: 'approve:1' }), ctx)
    assert.equal(tg.answers[0].text, 'Not attached')
})

test('dispatcher: menu callback without attach → "Not attached"', async () => {
    const { ctx, tg } = makeCtx()
    await routeUpdate(cb({ data: 'menu:0' }), ctx)
    assert.equal(tg.answers[0].text, 'Not attached')
})

test('dispatcher: key callback without attach → "Not attached"', async () => {
    const { ctx, tg } = makeCtx()
    await routeUpdate(cb({ data: 'key:Escape' }), ctx)
    assert.equal(tg.answers[0].text, 'Not attached')
})

test('dispatcher: unknown callback data → "Unknown action"', async () => {
    const { ctx, tg } = makeCtx()
    await routeUpdate(cb({ data: 'cancel' }), ctx)
    assert.equal(tg.answers[0].text, 'Unknown action')
})
