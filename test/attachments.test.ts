import { test } from './_runner.js'
import { strict as assert } from 'assert'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { pickAttachment, sanitizeName, resolveTarget, saveAttachment } from '../lib/attachments.js'
import type { TelegramClient, TelegramMessage } from '../lib/telegram.js'

test('sanitizeName: strips path traversal and separators', () => {
    assert.equal(sanitizeName('../../etc/passwd'), 'passwd')
    assert.equal(sanitizeName('a/b/c.txt'), 'c.txt')
})

test('sanitizeName: keeps safe chars, collapses the rest', () => {
    assert.equal(sanitizeName('a_b-c.PNG'), 'a_b-c.PNG')
    assert.equal(sanitizeName('hi there!.jpg'), 'hi_there_.jpg')
})

test('sanitizeName: empty / all-bad falls back to "file"', () => {
    assert.equal(sanitizeName(''), 'file')
    assert.equal(sanitizeName('///'), 'file')
})

test('pickAttachment: document → file_id + name + size', () => {
    const msg = {
        document: { file_id: 'D1', file_unique_id: 'u1', file_name: 'report.pdf', file_size: 123 },
    } as unknown as TelegramMessage
    const a = pickAttachment(msg)
    assert.equal(a?.fileId, 'D1')
    assert.equal(a?.suggestedName, 'report.pdf')
    assert.equal(a?.fileSize, 123)
})

test('pickAttachment: document without name → file-<unique_id>', () => {
    const msg = { document: { file_id: 'D2', file_unique_id: 'u2' } } as unknown as TelegramMessage
    assert.equal(pickAttachment(msg)?.suggestedName, 'file-u2')
})

test('pickAttachment: photo → largest size, jpg name', () => {
    const msg = {
        photo: [
            { file_id: 'P_s', file_unique_id: 'us', width: 90, height: 90 },
            { file_id: 'P_l', file_unique_id: 'ul', width: 1280, height: 720 },
        ],
    } as unknown as TelegramMessage
    const a = pickAttachment(msg)
    assert.equal(a?.fileId, 'P_l')
    assert.equal(a?.suggestedName, 'photo-ul.jpg')
})

test('pickAttachment: neither → null', () => {
    assert.equal(pickAttachment({ text: 'hi' } as unknown as TelegramMessage), null)
})

test('resolveTarget: collisions get -1, -2 suffixes before the extension', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'att-'))
    const first = await resolveTarget(dir, 'a.txt')
    assert.equal(path.basename(first), 'a.txt')
    await fs.writeFile(first, 'x')
    const second = await resolveTarget(dir, 'a.txt')
    assert.equal(path.basename(second), 'a-1.txt')
    await fs.writeFile(second, 'x')
    const third = await resolveTarget(dir, 'a.txt')
    assert.equal(path.basename(third), 'a-2.txt')
})

test('saveAttachment: downloads via fake tg and writes under <cwd>/.claude-bridge/uploads', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'cwd-'))
    const fakeTg: Pick<TelegramClient, 'getFile' | 'downloadFile'> = {
        getFile: async (id: string) => ({ file_id: id, file_unique_id: 'u', file_path: 'photos/x.jpg' }),
        downloadFile: async () => Buffer.from('hello-bytes'),
    }
    const { relPath, bytes } = await saveAttachment(fakeTg, 'F1', 'shot.png', cwd)
    assert.equal(relPath, path.join('.claude-bridge', 'uploads', 'shot.png'))
    assert.equal(bytes, Buffer.from('hello-bytes').length)
    const written = await fs.readFile(path.join(cwd, relPath))
    assert.equal(written.toString(), 'hello-bytes')
})

test('saveAttachment: throws when getFile returns no file_path', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'cwd-'))
    const fakeTg: Pick<TelegramClient, 'getFile' | 'downloadFile'> = {
        getFile: async (id: string) => ({ file_id: id, file_unique_id: 'u' }),
        downloadFile: async () => Buffer.from(''),
    }
    await assert.rejects(() => saveAttachment(fakeTg, 'F1', 'shot.png', cwd), /file_path/)
})
