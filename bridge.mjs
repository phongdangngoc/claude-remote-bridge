#!/usr/bin/env node
import readline from 'readline'
import fs from 'fs/promises'
import { spawn, spawnSync } from 'child_process'
import { TelegramClient } from './lib/telegram.mjs'
import { loadConfig, saveConfig, loadState, getConfigPath, getStatePath, DEFAULTS } from './lib/config.mjs'
import { runDaemon } from './lib/daemon.mjs'
import * as tmux from './lib/tmux.mjs'

function fail(msg, code = 1) {
    process.stderr.write(`bridge: ${msg}\n`)
    process.exit(code)
}

function info(msg) {
    process.stderr.write(`bridge: ${msg}\n`)
}

async function cmdInit() {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
    const ask = (prompt) => new Promise(resolve => rl.question(prompt, resolve))

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
    let imported = null
    const importPath = process.env.CLAUDE_BRIDGE_IMPORT_CREDS
    if (importPath) {
        try {
            const c = JSON.parse(await fs.readFile(importPath, 'utf8'))
            if (c.bot_token && c.chat_id) {
                const yn = (await ask(`Found existing creds at ${importPath}. Import? [Y/n] `)).trim().toLowerCase()
                if (yn !== 'n') imported = c
            }
        } catch {}
    }

    const bot_token = imported?.bot_token ?? (await ask('Bot token: ')).trim()
    const chat_id   = imported?.chat_id   ?? (await ask('Chat ID: ')).trim()
    const allowRaw  = (await ask(`Allowed user IDs (comma-separated, leave blank = [${chat_id}]): `)).trim()
    rl.close()

    if (!bot_token || !chat_id) fail('bot_token and chat_id required')

    const allowed_chat_ids = allowRaw
        ? allowRaw.split(',').map(s => Number(s.trim())).filter(Boolean)
        : [Number(chat_id)]

    const cfg = { bot_token, chat_id, allowed_chat_ids, ...DEFAULTS }
    await saveConfig(cfg)
    info(`Saved → ${getConfigPath()}`)
    info('Verifying token...')
    const tg = new TelegramClient(bot_token)
    const bot = await tg.getMe()
    info(`OK — bot @${bot.username}`)
}

async function cmdStatus() {
    try {
        const cfg = await loadConfig()
        const st = await loadState()
        info(`config:           ${getConfigPath()}`)
        info(`bot chat_id:      ${cfg.chat_id}`)
        info(`allowed_chat_ids: ${cfg.allowed_chat_ids.join(', ')}`)
        info(`state.attached:   ${st.attached_session ?? '(none)'}`)
        info(`state.last_update_id: ${st.last_update_id}`)
        // Check systemd
        const sd = spawnSync('systemctl', ['--user', 'is-active', 'claude-bridge.service'], { encoding: 'utf8' })
        info(`systemd status:   ${sd.stdout.trim() || 'unknown'}`)
    } catch (e) {
        fail(e.message)
    }
}

async function cmdLogs() {
    spawn('journalctl', ['--user', '-u', 'claude-bridge.service', '-f', '-n', '50'], { stdio: 'inherit' })
}

async function cmdNew(name, cwd) {
    if (!name) fail('Usage: bridge new <session-name> [cwd]')
    if (await tmux.hasSession(name)) fail(`Session ${name} already exists`)
    await tmux.newSession(name, { cwd })
    info(`Created tmux session ${name}`)
}

async function cmdAttach(name) {
    fail('CLI attach not implemented yet — use Telegram /attach. (Use `bridge logs` to watch daemon.)')
}

function cmdHelp() {
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

async function main() {
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
        fail(e.stack || e.message)
    }
}

main()
