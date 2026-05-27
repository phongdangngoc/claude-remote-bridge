import { stripAnsi } from './parser.mjs'

/**
 * Streamer takes incoming pane bytes, debounces, and dispatches to a sink (Telegram).
 *
 * Sink interface:
 *   sendNew(text) → Promise<message_id>
 *   edit(messageId, text) → Promise<void>
 *   onSilence(plainText, capture) → Promise<void>   // called once when stream goes idle
 *
 * Time injection (for tests): pass `now` and `setTimer` in opts.
 */
export class Streamer {
    constructor(sink, {
        silenceMs = 800,
        editThrottleMs = 1500,
        maxMessageChars = 4000,
        now = Date.now,
        setTimer = setTimeout,
        clearTimer = clearTimeout,
    } = {}) {
        this.sink = sink
        this.silenceMs = silenceMs
        this.editThrottleMs = editThrottleMs
        this.maxMessageChars = maxMessageChars
        this.now = now
        this.setTimer = setTimer
        this.clearTimer = clearTimer

        this.buffer = ''
        this.currentMessageId = null
        this.lastEditAt = 0
        this.silenceTimer = null
        this.editTimer = null
        this.pending = Promise.resolve()
        this.aborted = false
    }

    abort() {
        this.aborted = true
        this.clearTimer(this.silenceTimer)
        this.clearTimer(this.editTimer)
    }

    push(chunk) {
        if (this.aborted) return
        const text = stripAnsi(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
        if (!text) return
        this.buffer += text

        // Truncate head if overflow (keep tail)
        if (this.buffer.length > this.maxMessageChars * 2) {
            this.buffer = '[…truncated…]\n' + this.buffer.slice(-this.maxMessageChars)
            // Force new message after truncation
            this.currentMessageId = null
        }

        // Reset silence timer
        this.clearTimer(this.silenceTimer)
        this.silenceTimer = this.setTimer(() => this._onSilence(), this.silenceMs)

        // Schedule edit if not throttled
        this._scheduleEdit()

        // Split if buffer exceeds max
        if (this.buffer.length >= this.maxMessageChars) {
            this._finalizeAndSplit()
        }
    }

    _scheduleEdit() {
        if (this.editTimer) return
        const elapsed = this.now() - this.lastEditAt
        const wait = Math.max(0, this.editThrottleMs - elapsed)
        this.editTimer = this.setTimer(() => this._flushEdit(), wait)
    }

    async _flushEdit() {
        this.editTimer = null
        if (this.aborted || this.buffer.length === 0) return
        const snapshot = this._formatForTelegram(this.buffer)
        try {
            if (this.currentMessageId == null) {
                this.currentMessageId = await this.sink.sendNew(snapshot)
            } else {
                await this.sink.edit(this.currentMessageId, snapshot)
            }
            this.lastEditAt = this.now()
        } catch (e) {
            // Telegram error handling delegated to sink
            this.sink.onError?.(e)
            if (e.code === 400 && /not found|can't be edited/i.test(e.message)) {
                this.currentMessageId = null
            }
        }
    }

    async _onSilence() {
        // Final flush, then notify sink so it can run capture-pane + parse
        await this._flushEdit()
        try {
            await this.sink.onSilence?.(this.buffer)
        } catch (e) {
            this.sink.onError?.(e)
        }
        // Reset for next stream
        this.buffer = ''
        this.currentMessageId = null
    }

    async _finalizeAndSplit() {
        await this._flushEdit()
        this.buffer = ''
        this.currentMessageId = null
    }

    _formatForTelegram(text) {
        // Wrap in code block to preserve whitespace
        const truncated = text.length > this.maxMessageChars
            ? text.slice(-this.maxMessageChars)
            : text
        return '```\n' + truncated.replace(/```/g, '``​`') + '\n```'
    }
}
