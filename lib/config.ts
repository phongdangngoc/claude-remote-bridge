import fs from 'fs/promises'
import path from 'path'
import os from 'os'

const CONFIG_DIR = path.join(os.homedir(), '.config', 'claude-bridge')
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json')
const STATE_FILE = path.join(CONFIG_DIR, 'state.json')

export interface Defaults {
    silence_ms: number
    edit_throttle_ms: number
    max_message_chars: number
    snapshot_lines: number
    cursor_chars: string[]
    fifo_dir: string
}

export interface Config extends Defaults {
    bot_token: string
    chat_id: number | string
    allowed_chat_ids: number[]
    thread_id?: number
}

export interface State {
    attached_session: string | null
    last_update_id: number
    outbound_message_id: number | null
    saved_at?: string
}

export const DEFAULTS: Defaults = {
    silence_ms: 800,
    edit_throttle_ms: 1500,
    max_message_chars: 4000,
    snapshot_lines: 50,
    cursor_chars: ['❯', '►', '>'],
    fifo_dir: process.platform === 'linux'
        ? `/run/user/${process.getuid?.() ?? 1000}/claude-bridge`
        : path.join(os.tmpdir(), 'claude-bridge'),
}

export function getConfigPath(): string { return CONFIG_FILE }
export function getStatePath(): string  { return STATE_FILE }
export function getFifoDir(cfg: Pick<Config, 'fifo_dir'>): string { return cfg.fifo_dir ?? DEFAULTS.fifo_dir }

async function readJson<T>(p: string): Promise<T> {
    return JSON.parse(await fs.readFile(p, 'utf8')) as T
}

async function writeJson(p: string, obj: unknown, mode?: number): Promise<void> {
    await fs.mkdir(path.dirname(p), { recursive: true })
    await fs.writeFile(p, JSON.stringify(obj, null, 2) + '\n', 'utf8')
    if (mode) {
        try { await fs.chmod(p, mode) } catch {}
    }
}

export async function loadConfig(): Promise<Config> {
    const envToken = process.env.TELEGRAM_BOT_TOKEN
    const envChat = process.env.TELEGRAM_CHAT_ID
    if (envToken && envChat) {
        return { ...DEFAULTS, bot_token: envToken, chat_id: envChat, allowed_chat_ids: [Number(envChat)] }
    }
    let raw: Partial<Config>
    try {
        raw = await readJson<Partial<Config>>(CONFIG_FILE)
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
            throw new Error(
                `Config not found at ${CONFIG_FILE}\n` +
                `Run: node dist/bridge.js init`
            )
        }
        throw e
    }
    if (!raw.bot_token) throw new Error('config.json missing bot_token')
    if (!raw.chat_id)   throw new Error('config.json missing chat_id')
    return {
        ...DEFAULTS,
        ...raw,
        bot_token: raw.bot_token,
        chat_id: raw.chat_id,
        allowed_chat_ids: raw.allowed_chat_ids ?? [Number(raw.chat_id)],
    }
}

export async function saveConfig(cfg: Config): Promise<void> {
    const out: Partial<Config> = { ...cfg }
    delete (out as { fifo_dir?: string }).fifo_dir
    await writeJson(CONFIG_FILE, out, 0o600)
}

export async function loadState(): Promise<State> {
    const empty: State = { attached_session: null, last_update_id: 0, outbound_message_id: null }
    try {
        return await readJson<State>(STATE_FILE)
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return empty
        process.stderr.write(`[warn] state.json corrupt: ${(e as Error).message}\n`)
        return empty
    }
}

export async function saveState(state: State): Promise<void> {
    await writeJson(STATE_FILE, { ...state, saved_at: new Date().toISOString() }, 0o600)
}
