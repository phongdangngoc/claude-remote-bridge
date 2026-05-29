import { test } from './_runner.js'
import { strict as assert } from 'assert'
import { trimToLatestTurn, paneIsSettled } from '../lib/daemon.js'

const FOOTER = 'Session: 1a2b3c4d-0000-0000-0000-000000000000  ·  some stats'

test('paneIsSettled: idle prompt with a response bullet is settled', () => {
    const pane = [
        '❯ what is 2+2?',
        '',
        '● 4',
        '',
        '──────────────',
        '❯ ',
        '──────────────',
        FOOTER,
    ].join('\n')
    assert.equal(paneIsSettled(pane, { type: 'free' }), true)
})

test('paneIsSettled: active "esc to interrupt" status is not settled', () => {
    const pane = [
        '❯ build something',
        '',
        '● working on it',
        '',
        '✻ Cooking… (3s · esc to interrupt)',
        '❯ ',
        FOOTER,
    ].join('\n')
    assert.equal(paneIsSettled(pane, { type: 'free' }), false)
})

test('paneIsSettled: a response that says "ran for 5 s" does not wedge settle', () => {
    const pane = [
        '❯ how long did the build take?',
        '',
        '● It was waiting for 30 s, then ran for 5 s and passed.',
        '',
        '❯ ',
        FOOTER,
    ].join('\n')
    assert.equal(paneIsSettled(pane, { type: 'free' }), true)
})

test('paneIsSettled: approve/menu prompt is always settled', () => {
    assert.equal(paneIsSettled('anything at all', { type: 'approve', options: [] }), true)
    assert.equal(paneIsSettled('anything at all', { type: 'menu', options: [] }), true)
})

test('trimToLatestTurn: keeps the latest turn, drops scrollback + footer + empty cursor', () => {
    const pane = [
        'old stuff from a previous turn',
        '❯ latest question',
        '',
        '● the answer',
        '',
        '❯ ',
        FOOTER,
        'more footer noise',
    ].join('\n')
    const out = trimToLatestTurn(pane)
    assert.ok(out.includes('latest question'), 'keeps the user question')
    assert.ok(out.includes('the answer'), 'keeps the response')
    assert.ok(!out.includes('old stuff'), 'drops earlier scrollback')
    assert.ok(!out.includes('Session:'), 'drops the status footer')
    assert.ok(!/\n❯\s*$/.test(out), 'drops the trailing empty cursor')
})
