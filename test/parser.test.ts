import { test } from './_runner.js'
import { strict as assert } from 'assert'
import fs from 'fs/promises'
import { stripAnsi, detectPrompt, PromptResult } from '../lib/parser.js'

function expectOptions(result: PromptResult, type: 'approve' | 'menu'): PromptResult & { type: typeof type } {
    if (result.type !== type) {
        throw new Error(`expected ${type}, got ${result.type}`)
    }
    return result as PromptResult & { type: typeof type }
}

test('stripAnsi removes CSI colour codes', () => {
    const input = '\x1b[31mhello\x1b[0m world'
    assert.equal(stripAnsi(input), 'hello world')
})

test('stripAnsi removes cursor positioning', () => {
    const input = 'before\x1b[2K\x1b[1Gafter'
    assert.equal(stripAnsi(input), 'beforeafter')
})

test('stripAnsi handles empty input', () => {
    assert.equal(stripAnsi(''), '')
})

test('detectPrompt: approve dialog', async () => {
    const text = await fs.readFile('test/fixtures/approve-prompt.txt', 'utf8')
    const result = expectOptions(detectPrompt(text), 'approve')
    assert.equal(result.options.length, 3)
    assert.equal(result.options[0].label, 'Yes')
    assert.equal(result.options[1].label, 'Yes, and allow all sessions')
    assert.equal(result.options[2].label, 'No (Esc)')
})

test('detectPrompt: multi-choice menu', async () => {
    const text = await fs.readFile('test/fixtures/menu-prompt.txt', 'utf8')
    const result = expectOptions(detectPrompt(text), 'menu')
    assert.ok(result.options.length >= 3)
    assert.equal(result.options[0].label, 'OAuth via SSO')
    assert.equal(result.options[0].selected, true)
})

test('detectPrompt: free text (no cursor)', () => {
    const result = detectPrompt('Just some output\nNo prompt here.\n')
    assert.equal(result.type, 'free')
})

test('detectPrompt: cursor but no menu structure', () => {
    const result = detectPrompt('> some text without a real menu\n')
    assert.equal(result.type, 'free')
})
