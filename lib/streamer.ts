import { stripAnsi } from './parser.js'

export interface Sink {
    sendNew(text: string): Promise<number>
    edit(messageId: number, text: string): Promise<void>
    onSilence?(plainText: string): Promise<void>
    onError?(err: Error & { code?: number }): void
}

export interface Clock {
    now?: () => number
    setTimer?: (cb: () => void, ms: number) => unknown
    clearTimer?: (t: unknown) => void
}

export interface StreamerOpts extends Clock {
    silenceMs?: number
    editThrottleMs?: number
    maxMessageChars?: number
}

type TimerHandle = unknown

export class Streamer {
    private sink: Sink
    private silenceMs: number
    private editThrottleMs: number
    private maxMessageChars: number
    private now: () => number
    private setTimer: (cb: () => void, ms: number) => TimerHandle
    private clearTimer: (t: TimerHandle) => void

    private buffer = ''
    private currentMessageId: number | null = null
    private lastEditAt = 0
    private silenceTimer: TimerHandle = null
    private editTimer: TimerHandle = null
    private aborted = false

    constructor(sink: Sink, opts: StreamerOpts = {}) {
        this.sink = sink
        this.silenceMs = opts.silenceMs ?? 800
        this.editThrottleMs = opts.editThrottleMs ?? 1500
        this.maxMessageChars = opts.maxMessageChars ?? 4000
        this.now = opts.now ?? Date.now
        this.setTimer = (opts.setTimer ?? ((cb: () => void, ms: number) => setTimeout(cb, ms))) as typeof this.setTimer
        this.clearTimer = (opts.clearTimer ?? ((t: TimerHandle) => clearTimeout(t as ReturnType<typeof setTimeout>))) as typeof this.clearTimer
    }

    abort(): void {
        this.aborted = true
        this.clearTimer(this.silenceTimer)
        this.clearTimer(this.editTimer)
    }

    push(chunk: string | Buffer): void {
        if (this.aborted) return
        const text = stripAnsi(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
        if (!text) return
        this.buffer += text

        if (this.buffer.length > this.maxMessageChars * 2) {
            this.buffer = '[…truncated…]\n' + this.buffer.slice(-this.maxMessageChars)
            this.currentMessageId = null
        }

        this.clearTimer(this.silenceTimer)
        this.silenceTimer = this.setTimer(() => { void this._onSilence() }, this.silenceMs)

        this._scheduleEdit()

        if (this.buffer.length >= this.maxMessageChars) {
            void this._finalizeAndSplit()
        }
    }

    private _scheduleEdit(): void {
        if (this.editTimer) return
        const elapsed = this.now() - this.lastEditAt
        const wait = Math.max(0, this.editThrottleMs - elapsed)
        this.editTimer = this.setTimer(() => { void this._flushEdit() }, wait)
    }

    private async _flushEdit(): Promise<void> {
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
            const err = e as Error & { code?: number }
            this.sink.onError?.(err)
            if (err.code === 400 && /not found|can't be edited/i.test(err.message)) {
                this.currentMessageId = null
            }
        }
    }

    private async _onSilence(): Promise<void> {
        await this._flushEdit()
        try {
            await this.sink.onSilence?.(this.buffer)
        } catch (e) {
            this.sink.onError?.(e as Error)
        }
        this.buffer = ''
        this.currentMessageId = null
    }

    private async _finalizeAndSplit(): Promise<void> {
        await this._flushEdit()
        this.buffer = ''
        this.currentMessageId = null
    }

    private _formatForTelegram(text: string): string {
        const truncated = text.length > this.maxMessageChars
            ? text.slice(-this.maxMessageChars)
            : text
        return '```\n' + truncated.replace(/```/g, '``​`') + '\n```'
    }
}
