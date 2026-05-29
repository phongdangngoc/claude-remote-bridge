import https from 'https'

const HOST = 'api.telegram.org'

export interface TelegramUser {
    id: number
    is_bot: boolean
    username?: string
    first_name?: string
}

export interface TelegramChat {
    id: number
    type: string
    title?: string
}

export interface TelegramMessage {
    message_id: number
    from?: TelegramUser
    chat: TelegramChat
    text?: string
    date: number
    message_thread_id?: number
}

export interface TelegramCallbackQuery {
    id: string
    from: TelegramUser
    message?: TelegramMessage
    data?: string
    message_thread_id?: number
}

export interface TelegramUpdate {
    update_id: number
    message?: TelegramMessage
    callback_query?: TelegramCallbackQuery
}

export interface InlineKeyboardButton {
    text: string
    callback_data: string
}

export interface ReplyMarkup {
    inline_keyboard: InlineKeyboardButton[][]
}

export interface SendMessageOpts {
    parse_mode?: string
    reply_markup?: ReplyMarkup
    reply_to_message_id?: number
    thread_id?: number
}

export interface EditMessageOpts {
    parse_mode?: string
    reply_markup?: ReplyMarkup
}

export interface ClientOpts {
    defaultThreadId?: number | null
}

export interface TelegramError extends Error {
    code: number
    parameters?: { retry_after?: number }
    method?: string
}

function request<T>(token: string, method: string, payload: Record<string, unknown>, timeoutMs = 35000): Promise<T> {
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
            const chunks: Buffer[] = []
            res.on('data', (c: Buffer) => chunks.push(c))
            res.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf8')
                let parsed: { ok: boolean; result?: T; description?: string; error_code?: number; parameters?: { retry_after?: number }; raw?: string }
                try { parsed = JSON.parse(raw) } catch { parsed = { ok: false, raw } }
                const status = res.statusCode ?? 0
                if (status >= 200 && status < 300 && parsed.ok && parsed.result !== undefined) {
                    resolve(parsed.result)
                } else {
                    const err = new Error(parsed.description || `HTTP ${status}`) as TelegramError
                    err.code = parsed.error_code ?? status
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
    private token: string
    private defaultThreadId: number | null

    constructor(token: string, opts: ClientOpts = {}) {
        this.token = token
        this.defaultThreadId = opts.defaultThreadId ?? null
    }

    getUpdates(offset: number, timeout = 30): Promise<TelegramUpdate[]> {
        return request<TelegramUpdate[]>(
            this.token,
            'getUpdates',
            { offset, timeout, allowed_updates: ['message', 'callback_query'] },
            (timeout + 5) * 1000
        )
    }

    sendMessage(chatId: number | string, text: string, opts: SendMessageOpts = {}): Promise<TelegramMessage> {
        return request<TelegramMessage>(this.token, 'sendMessage', {
            chat_id: chatId,
            text,
            parse_mode: opts.parse_mode ?? 'Markdown',
            disable_web_page_preview: true,
            reply_markup: opts.reply_markup,
            reply_to_message_id: opts.reply_to_message_id,
            message_thread_id: opts.thread_id ?? this.defaultThreadId ?? undefined,
        })
    }

    editMessageText(chatId: number | string, messageId: number, text: string, opts: EditMessageOpts = {}): Promise<TelegramMessage | true> {
        return request<TelegramMessage | true>(this.token, 'editMessageText', {
            chat_id: chatId,
            message_id: messageId,
            text,
            parse_mode: opts.parse_mode ?? 'Markdown',
            disable_web_page_preview: true,
            reply_markup: opts.reply_markup,
        })
    }

    editMessageReplyMarkup(chatId: number | string, messageId: number, replyMarkup: ReplyMarkup): Promise<TelegramMessage | true> {
        return request<TelegramMessage | true>(this.token, 'editMessageReplyMarkup', {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: replyMarkup,
        })
    }

    answerCallbackQuery(callbackQueryId: string, text?: string): Promise<boolean> {
        return request<boolean>(this.token, 'answerCallbackQuery', {
            callback_query_id: callbackQueryId,
            text,
            show_alert: false,
        })
    }

    deleteWebhook(): Promise<boolean> {
        return request<boolean>(this.token, 'deleteWebhook', { drop_pending_updates: false })
    }

    getMe(): Promise<TelegramUser> {
        return request<TelegramUser>(this.token, 'getMe', {}, 10000)
    }
}

// Escape text for parse_mode:'HTML'. Telegram's legacy 'Markdown' has no
// reliable escaping, so any message that interpolates Claude-derived text
// (option labels, file paths, commands) must go out as HTML with the three
// reserved characters escaped — otherwise an unbalanced * _ ` [ makes the
// Bot API reject the whole send with HTTP 400 and the buttons never appear.
export function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function isErr(err: unknown): err is TelegramError {
    return err instanceof Error && typeof (err as TelegramError).code === 'number'
}

export function isRateLimit(err: unknown): boolean      { return isErr(err) && err.code === 429 }
export function isNotModified(err: unknown): boolean    { return isErr(err) && err.code === 400 && /not modified/i.test(err.message) }
export function isTooOldToEdit(err: unknown): boolean   { return isErr(err) && err.code === 400 && /message to edit not found|message can't be edited/i.test(err.message) }
export function isInvalidToken(err: unknown): boolean   { return isErr(err) && err.code === 401 }
