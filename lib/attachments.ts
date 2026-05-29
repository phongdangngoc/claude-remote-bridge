import fs from 'fs/promises'
import path from 'path'
import type { TelegramClient, TelegramMessage } from './telegram.js'

export interface PickedAttachment {
    fileId: string
    suggestedName: string
    fileSize?: number
}

// Decide which attachment (if any) a message carries. Documents win over
// photos: sending as a document is an explicit "use this exact file" signal.
export function pickAttachment(msg: TelegramMessage): PickedAttachment | null {
    if (msg.document) {
        const d = msg.document
        return {
            fileId: d.file_id,
            suggestedName: d.file_name ?? `file-${d.file_unique_id}`,
            fileSize: d.file_size,
        }
    }
    if (msg.photo && msg.photo.length > 0) {
        const largest = msg.photo.reduce((a, b) =>
            b.width * b.height >= a.width * a.height ? b : a)
        return {
            fileId: largest.file_id,
            suggestedName: `photo-${largest.file_unique_id}.jpg`,
            fileSize: largest.file_size,
        }
    }
    return null
}

// Make a Telegram-supplied filename safe to write inside uploads/: basename
// only, allow just [A-Za-z0-9._-], collapse other runs to '_', strip leading
// dot/dash, and fall back to 'file' if nothing survives.
export function sanitizeName(name: string): string {
    const base = name.split(/[\\/]/).pop() ?? ''
    const cleaned = base
        .replace(/[^A-Za-z0-9._-]+/g, '_')
        .replace(/^[._-]+/, '')
    return cleaned.length > 0 ? cleaned : 'file'
}

// Resolve a non-colliding absolute path inside dir for name, inserting
// -1, -2, … before the extension on collision.
export async function resolveTarget(dir: string, name: string): Promise<string> {
    const ext = path.extname(name)
    const stem = name.slice(0, name.length - ext.length)
    let candidate = path.join(dir, name)
    let n = 0
    while (true) {
        try {
            await fs.access(candidate)  // resolves if the path exists
        } catch {
            return candidate            // does not exist → free to use
        }
        n++
        candidate = path.join(dir, `${stem}-${n}${ext}`)
    }
}

// Download the attachment via tg and write it under <cwd>/.claude-bridge/uploads.
// Returns the path relative to cwd plus the byte count.
export async function saveAttachment(
    tg: Pick<TelegramClient, 'getFile' | 'downloadFile'>,
    fileId: string,
    suggestedName: string,
    cwd: string,
): Promise<{ relPath: string; bytes: number }> {
    const file = await tg.getFile(fileId)
    if (!file.file_path) throw new Error('Telegram getFile returned no file_path')
    const buf = await tg.downloadFile(file.file_path)
    const dir = path.join(cwd, '.claude-bridge', 'uploads')
    await fs.mkdir(dir, { recursive: true })
    const target = await resolveTarget(dir, sanitizeName(suggestedName))
    await fs.writeFile(target, buf)
    return { relPath: path.relative(cwd, target), bytes: buf.length }
}
