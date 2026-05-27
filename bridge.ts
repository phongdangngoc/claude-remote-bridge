#!/usr/bin/env node
import readline from 'readline'
import fs from 'fs/promises'
import { spawn, spawnSync } from 'child_process'
import { TelegramClient } from './lib/telegram.js'
import { loadConfig, saveConfig, loadState, getConfigPath, getStatePath, DEFAULTS, Config } from './lib/config.js'
import { runDaemon } from './lib/daemon.js'
import * as tmux from './lib/tmux.js'
import { errMsg } from './lib/errors.js'

function fail(msg: string, code = 1): never {
    process.stderr.write(`bridge: ${msg}\n`)
    process.exit(code)
}

function info(msg: string): void {
    process.stderr.write(`bridge: ${msg}\n`)
}

interface ImportedCreds {
    bot_token: string
    chat_id: string | number
}

async function cmdInit(): Promise<void> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
    const ask = (prompt: string): Promise<string> => new Promise(resolve => rl.question(prompt, resolve))

    info('Setting up Telegram credentials.')
    process.stderr.write(
        '  1. Create or reuse a bot at https://t.me/BotFather → /newbot\n' +
        '  2. Copy the bot token.\n' +
        '  3. Add bot to a private chat with yourself. Open:\n' +
        '     https://api.telegram.org/bot<TOKEN>/getUpdates\n' +
        '     Look for "chat":{"id": …}\n\n'
    )

    // Optional: import from an existing credentials file via env var.
    // Format: { "bot_token": "...", "chat_id": "..." }
    let imported: ImportedCreds | null = null
    const importPath = process.env.CLAUDE_BRIDGE_IMPORT_CREDS
    if (importPath) {
        try {
            const c = JSON.parse(await fs.readFile(importPath, 'utf8')) as Partial<ImportedCreds>
            if (c.bot_token && c.chat_id) {
                const yn = (await ask(`Found existing creds at ${importPath}. Import? [Y/n] `)).trim().toLowerCase()
                if (yn !== 'n') imported = { bot_token: c.bot_token, chat_id: c.chat_id }
            }
        } catch {}
    }

    const bot_token = imported?.bot_token ?? (await ask('Bot token: ')).trim()
    const chat_id   = imported?.chat_id   ?? (await ask('Chat ID: ')).trim()
    const allowRaw  = (await ask(`Allowed user IDs (comma-separated, leave blank = [${chat_id}]): `)).trim()
    const threadRaw = (await ask('Forum topic / thread ID (leave blank for none): ')).trim()
    rl.close()

    if (!bot_token || !chat_id) fail('bot_token and chat_id required')

    const allowed_chat_ids = allowRaw
        ? allowRaw.split(',').map((s: string) => Number(s.trim())).filter(Boolean)
        : [Number(chat_id)]

    const cfg: Config = { ...DEFAULTS, bot_token, chat_id, allowed_chat_ids }
    if (threadRaw) cfg.thread_id = Number(threadRaw)
    await saveConfig(cfg)
    info(`Saved → ${getConfigPath()}`)
    info('Verifying token...')
    const tg = new TelegramClient(bot_token)
    const bot = await tg.getMe()
    info(`OK — bot @${bot.username ?? '(unknown)'}`)
}

async function cmdStatus(): Promise<void> {
    try {
        const cfg = await loadConfig()
        const st = await loadState()
        info(`config:           ${getConfigPath()}`)
        info(`bot chat_id:      ${cfg.chat_id}`)
        info(`allowed_chat_ids: ${cfg.allowed_chat_ids.join(', ')}`)
        info(`state.attached:   ${st.attached_session ?? '(none)'}`)
        info(`state.last_update_id: ${st.last_update_id}`)
        const sd = spawnSync('systemctl', ['--user', 'is-active', 'claude-bridge.service'], { encoding: 'utf8' })
        info(`systemd status:   ${sd.stdout.trim() || 'unknown'}`)
    } catch (e) {
        fail(errMsg(e))
    }
}

async function cmdLogs(): Promise<void> {
    spawn('journalctl', ['--user', '-u', 'claude-bridge.service', '-f', '-n', '50'], { stdio: 'inherit' })
}

async function cmdNew(name: string | undefined, cwd: string | undefined): Promise<void> {
    if (!name) fail('Usage: bridge new <session-name> [cwd]')
    if (await tmux.hasSession(name)) fail(`Session ${name} already exists`)
    await tmux.newSession(name, { cwd })
    info(`Created tmux session ${name}`)
}

async function cmdAttach(_name: string | undefined): Promise<void> {
    fail('CLI attach not implemented yet — use Telegram /attach. (Use `bridge logs` to watch daemon.)')
}

function cmdHelp(): void {
    process.stdout.write(`bridge — claude-remote-bridge CLI

Commands:
  daemon                 Run the bridge daemon (foreground; used by systemd)
  init                   Interactive: configure bot token + chat_id + allowlist
  status                 Show config + state + systemd status
  logs                   Tail journalctl --user -u claude-bridge.service
  new <name> [cwd]       tmux new -d -s <name> -c <cwd> 'claude'
  attach <name>          (not implemented — use Telegram /attach)
  help                   Show this help

Config path: ${getConfigPath()}
State path:  ${getStatePath()}
`)
}

async function main(): Promise<void> {
    const [sub, ...rest] = process.argv.slice(2)
    try {
        switch (sub) {
            case 'daemon': await runDaemon(); break
            case 'init':   await cmdInit();   break
            case 'status': await cmdStatus(); break
            case 'logs':   await cmdLogs();   break
            case 'new':    await cmdNew(rest[0], rest[1]); break
            case 'attach': await cmdAttach(rest[0]); break
            case 'help':
            case '--help':
            case '-h':
            case undefined: cmdHelp(); break
            default:
                fail(`Unknown command: ${sub}. Try: bridge help`)
        }
    } catch (e) {
        fail(e instanceof Error ? (e.stack || e.message) : errMsg(e))
    }
}

void main()
