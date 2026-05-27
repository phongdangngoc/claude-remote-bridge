const ANSI_CSI   = /\x1b\[[0-9;?]*[a-zA-Z]/g
const ANSI_OSC   = /\x1b\][^\x07]*\x07/g
const ANSI_2BYTE = /\x1b[78MD]/g

export function stripAnsi(text: unknown): string {
    return String(text)
        .replace(ANSI_CSI, '')
        .replace(ANSI_OSC, '')
        .replace(ANSI_2BYTE, '')
}

const CURSORS = ['❯', '►', '>']

function buildCursorPattern(): RegExp {
    const escaped = CURSORS.map(c => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('')
    return new RegExp(`[${escaped}]`)
}

const CURSOR_RE = buildCursorPattern()

export interface Option {
    index: number
    label: string
    selected?: boolean
}

export type PromptResult =
    | { type: 'free' }
    | { type: 'approve'; options: Option[] }
    | { type: 'menu'; options: Option[] }

function lastN(text: string, n: number): string {
    const lines = text.split('\n')
    return lines.slice(-n).join('\n')
}

function extractNumberedOptions(text: string): Option[] {
    const lines = text.split('\n')
    const options: Option[] = []
    for (const line of lines) {
        const m = /^[\s❯►>]*(\d+)\.\s+(.+?)\s*$/.exec(line)
        if (m) options.push({ index: Number(m[1]), label: m[2].trim() })
    }
    return options
}

function extractMenuOptions(text: string): Option[] {
    const lines = text.split('\n')
    const cursorIdx = lines.findIndex(l => CURSOR_RE.test(l))
    if (cursorIdx < 0) return []
    let start = cursorIdx, end = cursorIdx
    while (start > 0 && /^\s+\S/.test(lines[start - 1])) start--
    while (end < lines.length - 1 && /^\s+\S/.test(lines[end + 1])) end++
    const block = lines.slice(start, end + 1)
    return block.map((line, i) => {
        const label = line.replace(/^[\s❯►>]+/, '').trim()
        return { index: i, label, selected: CURSOR_RE.test(line) }
    }).filter(o => o.label.length > 0)
}

export function detectPrompt(plainText: string): PromptResult {
    const last20 = lastN(plainText, 20)
    const hasCursor = CURSOR_RE.test(last20)

    if (!hasCursor) return { type: 'free' }

    const numbered = extractNumberedOptions(last20)
    const looksLikeApprove =
        numbered.length >= 2 &&
        numbered.length <= 5 &&
        /yes/i.test(numbered[0]?.label ?? '') &&
        (/proceed|approve|allow|do you want/i.test(last20))

    if (looksLikeApprove) {
        return { type: 'approve', options: numbered }
    }

    const menuOpts = extractMenuOptions(last20)
    if (menuOpts.length >= 2) {
        return { type: 'menu', options: menuOpts }
    }

    return { type: 'free' }
}
