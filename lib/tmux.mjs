import { spawn } from 'child_process'

function run(args, opts = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn('tmux', args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts })
        let stdout = '', stderr = ''
        child.stdout.on('data', (d) => stdout += d.toString())
        child.stderr.on('data', (d) => stderr += d.toString())
        child.on('error', reject)
        child.on('close', (code) => {
            if (code === 0) resolve(stdout)
            else {
                const err = new Error(`tmux ${args.join(' ')} → exit ${code}: ${stderr.trim()}`)
                err.code = code
                err.stderr = stderr
                reject(err)
            }
        })
    })
}

export async function hasSession(name) {
    try {
        await run(['has-session', '-t', name])
        return true
    } catch {
        return false
    }
}

export async function listSessions() {
    try {
        const out = await run(['list-sessions', '-F', '#{session_name}\t#{session_attached}\t#{session_windows}'])
        return out.trim().split('\n').filter(Boolean).map(line => {
            const [name, attached, windows] = line.split('\t')
            return { name, attached: attached === '1', windows: Number(windows) }
        })
    } catch (e) {
        if (/no server running|no sessions/i.test(e.stderr || '')) return []
        throw e
    }
}

export async function sendKeys(session, text, { literal = true } = {}) {
    const args = ['send-keys', '-t', session]
    if (literal) args.push('-l')
    args.push(text)
    await run(args)
}

export async function sendEnter(session) {
    await run(['send-keys', '-t', session, 'Enter'])
}

export async function sendSpecialKey(session, key) {
    // key examples: 'Enter', 'Escape', 'Up', 'Down', 'Left', 'Right', 'C-c'
    await run(['send-keys', '-t', session, key])
}

export async function capturePane(session, { lines = 50, withEscapes = false } = {}) {
    const args = ['capture-pane', '-p', '-t', session, '-S', `-${lines}`]
    if (withEscapes) args.push('-e')
    return await run(args)
}

export async function pipePaneStart(session, command) {
    // Toggle off any existing pipe first to be safe
    try { await run(['pipe-pane', '-t', session]) } catch {}
    await run(['pipe-pane', '-O', '-t', session, command])
}

export async function pipePaneStop(session) {
    try { await run(['pipe-pane', '-t', session]) } catch {}
}

export async function newSession(name, { cwd, command = 'claude' } = {}) {
    const args = ['new-session', '-d', '-s', name]
    if (cwd) args.push('-c', cwd)
    args.push(command)
    await run(args)
}

export async function killSession(name) {
    await run(['kill-session', '-t', name])
}
