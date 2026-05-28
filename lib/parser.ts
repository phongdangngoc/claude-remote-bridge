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

    // Strategy 1 — numbered Claude Code menu:
    //   ❯ 1. Ngựa
    //        description (indented continuation, ignored)
    //     2. Hươu cao cổ
    //     ...
    //     N. Last option
    // Find consecutive 1..N at the END of the snapshot (so passing references
    // like "step 1." earlier in the response don't get mistaken for the menu).
    const numberedRe = /^(\s*[❯►>]?\s*)(\d+)\.\s+(\S.*?)\s*$/
    const hits: Array<{ label: string; num: number; selected: boolean }> = []
    for (const line of lines) {
        const m = numberedRe.exec(line)
        if (m) hits.push({ label: m[3], num: Number(m[2]), selected: CURSOR_RE.test(m[1]) })
    }
    if (hits.length >= 2) {
        const tail = [hits[hits.length - 1]]
        for (let i = hits.length - 2; i >= 0; i--) {
            if (hits[i].num === tail[0].num - 1) tail.unshift(hits[i])
            else break
        }
        if (tail.length >= 2 && tail[0].num === 1) {
            return tail.map((h, i) => ({ index: i, label: h.label, selected: h.selected }))
        }
    }

    // Strategy 2 — legacy indented block menu (non-numbered, walks the indented
    // block surrounding a cursor line).
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
    const last20 = lastN(plainText, 40)
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
