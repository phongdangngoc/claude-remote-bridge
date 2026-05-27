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
    constructor(token, opts = {}) {
        this.token = token
        this.defaultThreadId = opts.defaultThreadId ?? null
    }

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
            message_thread_id: opts.thread_id ?? this.defaultThreadId ?? undefined,
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
