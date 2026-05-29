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

test('detectPrompt: numbered Claude Code menu', () => {
    const text = 'Pick an animal:\n\n❯ 1. Ngựa\n  2. Hươu cao cổ\n  3. Ngựa vằn\n'
    const result = expectOptions(detectPrompt(text), 'menu')
    assert.equal(result.options.length, 3)
    assert.equal(result.options[0].label, 'Ngựa')
    assert.equal(result.options[0].selected, true)
    assert.equal(result.options[2].label, 'Ngựa vằn')
})

test('detectPrompt: free text (no cursor)', () => {
    const result = detectPrompt('Just some output\nNo prompt here.\n')
    assert.equal(result.type, 'free')
})

test('detectPrompt: cursor but no menu structure', () => {
    const result = detectPrompt('> some text without a real menu\n')
    assert.equal(result.type, 'free')
})

test('detectPrompt: prose numbered list is NOT a menu (no ❯ pointer)', () => {
    const text = 'Here is the plan:\n1. Install deps\n2. Build the project\n3. Run the daemon\n'
    assert.equal(detectPrompt(text).type, 'free')
})

test('detectPrompt: blockquoted numbered list is NOT a prompt (> is not a strong cursor)', () => {
    const text = 'You asked me to:\n> 1. yes do the install\n> 2. no\nShould I proceed?\n'
    assert.equal(detectPrompt(text).type, 'free')
})
