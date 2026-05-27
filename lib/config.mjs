import fs from 'fs/promises'
import path from 'path'
import os from 'os'

const CONFIG_DIR = path.join(os.homedir(), '.config', 'claude-bridge')
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json')
const STATE_FILE = path.join(CONFIG_DIR, 'state.json')

export const DEFAULTS = {
    silence_ms: 800,
    edit_throttle_ms: 1500,
    max_message_chars: 4000,
    snapshot_lines: 50,
    cursor_chars: ['❯', '►', '>'],
    fifo_dir: process.platform === 'linux'
        ? `/run/user/${process.getuid?.() ?? 1000}/claude-bridge`
        : path.join(os.tmpdir(), 'claude-bridge'),
}

export function getConfigPath() { return CONFIG_FILE }
export function getStatePath()  { return STATE_FILE }
export function getFifoDir(cfg) { return cfg.fifo_dir ?? DEFAULTS.fifo_dir }

async function readJson(p) {
    return JSON.parse(await fs.readFile(p, 'utf8'))
}

async function writeJson(p, obj, mode) {
    await fs.mkdir(path.dirname(p), { recursive: true })
    await fs.writeFile(p, JSON.stringify(obj, null, 2) + '\n', 'utf8')
    if (mode) {
        try { await fs.chmod(p, mode) } catch {}
    }
}

export async function loadConfig() {
    const envToken = process.env.TELEGRAM_BOT_TOKEN
    const envChat = process.env.TELEGRAM_CHAT_ID
    if (envToken && envChat) {
        return { ...DEFAULTS, bot_token: envToken, chat_id: envChat, allowed_chat_ids: [Number(envChat)] }
    }
    let raw
    try {
        raw = await readJson(CONFIG_FILE)
    } catch (e) {
        if (e.code === 'ENOENT') {
            throw new Error(
                `Config not found at ${CONFIG_FILE}\n` +
                `Run: node bridge.mjs init`
            )
        }
        throw e
    }
    if (!raw.bot_token) throw new Error('config.json missing bot_token')
    if (!raw.chat_id)   throw new Error('config.json missing chat_id')
    return {
        ...DEFAULTS,
        ...raw,
        allowed_chat_ids: raw.allowed_chat_ids ?? [Number(raw.chat_id)],
    }
}

export async function saveConfig(cfg) {
    const out = { ...cfg }
    delete out.fifo_dir  // computed, not stored
    await writeJson(CONFIG_FILE, out, 0o600)
}

export async function loadState() {
    try {
        return await readJson(STATE_FILE)
    } catch (e) {
        if (e.code === 'ENOENT') {
            return { attached_session: null, last_update_id: 0, outbound_message_id: null }
        }
        // Corrupt state file: warn, return empty
        process.stderr.write(`[warn] state.json corrupt: ${e.message}\n`)
        return { attached_session: null, last_update_id: 0, outbound_message_id: null }
    }
}

export async function saveState(state) {
    await writeJson(STATE_FILE, { ...state, saved_at: new Date().toISOString() }, 0o600)
}
