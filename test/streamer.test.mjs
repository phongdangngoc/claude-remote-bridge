import { test } from './_runner.mjs'
import { strict as assert } from 'assert'
import { Streamer } from '../lib/streamer.mjs'

function makeFakeClock() {
    let current = 0
    const timers = []
    return {
        now: () => current,
        setTimer: (cb, delay) => {
            const t = { cb, fireAt: current + delay, cancelled: false }
            timers.push(t)
            return t
        },
        clearTimer: (t) => { if (t) t.cancelled = true },
        advance: async (ms) => {
            const target = current + ms
            // Fire timers in order
            timers.sort((a, b) => a.fireAt - b.fireAt)
            for (const t of timers) {
                if (t.cancelled) continue
                if (t.fireAt <= target) {
                    current = t.fireAt
                    t.cancelled = true
                    await t.cb()
                }
            }
            current = target
        },
    }
}

function makeFakeSink() {
    const events = []
    let nextId = 100
    return {
        events,
        sendNew: async (text) => {
            const id = nextId++
            events.push({ type: 'sendNew', id, text })
            return id
        },
        edit: async (id, text) => { events.push({ type: 'edit', id, text }) },
        onSilence: async (buf) => { events.push({ type: 'silence', buf }) },
        onError: (e) => { events.push({ type: 'error', message: e.message }) },
    }
}

test('Streamer: first chunk sends new message after throttle wait', async () => {
    const clock = makeFakeClock()
    const sink = makeFakeSink()
    const s = new Streamer(sink, { silenceMs: 800, editThrottleMs: 1500, ...clock })
    s.push('hello')
    await clock.advance(1500)
    const sends = sink.events.filter(e => e.type === 'sendNew')
    assert.equal(sends.length, 1)
    assert.match(sends[0].text, /hello/)
})

test('Streamer: silence triggers onSilence', async () => {
    const clock = makeFakeClock()
    const sink = makeFakeSink()
    const s = new Streamer(sink, { silenceMs: 800, editThrottleMs: 1500, ...clock })
    s.push('hello')
    await clock.advance(2000)
    const silenceEvents = sink.events.filter(e => e.type === 'silence')
    assert.equal(silenceEvents.length, 1)
})

test('Streamer: subsequent chunks edit same message', async () => {
    const clock = makeFakeClock()
    const sink = makeFakeSink()
    const s = new Streamer(sink, { silenceMs: 2000, editThrottleMs: 100, ...clock })
    s.push('part1')
    await clock.advance(150)
    s.push('part2')
    await clock.advance(150)
    s.push('part3')
    await clock.advance(150)
    const edits = sink.events.filter(e => e.type === 'edit')
    assert.ok(edits.length >= 1, `expected at least 1 edit, got ${edits.length}`)
})

test('Streamer: ANSI is stripped', async () => {
    const clock = makeFakeClock()
    const sink = makeFakeSink()
    const s = new Streamer(sink, { silenceMs: 800, editThrottleMs: 0, ...clock })
    s.push('\x1b[31mred\x1b[0m text')
    await clock.advance(100)
    const sends = sink.events.filter(e => e.type === 'sendNew')
    assert.ok(!sends[0].text.includes('\x1b'))
    assert.match(sends[0].text, /red text/)
})

test('Streamer: abort prevents further sends', async () => {
    const clock = makeFakeClock()
    const sink = makeFakeSink()
    const s = new Streamer(sink, { silenceMs: 800, editThrottleMs: 0, ...clock })
    s.abort()
    s.push('hello')
    await clock.advance(2000)
    assert.equal(sink.events.length, 0)
})
