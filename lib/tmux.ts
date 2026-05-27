import { spawn, SpawnOptions } from 'child_process'

interface TmuxError extends Error {
    code: number
    stderr: string
}

function run(args: string[], opts: SpawnOptions = {}): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn('tmux', args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts })
        let stdout = '', stderr = ''
        child.stdout!.on('data', (d: Buffer) => stdout += d.toString())
        child.stderr!.on('data', (d: Buffer) => stderr += d.toString())
        child.on('error', reject)
        child.on('close', (code) => {
            if (code === 0) resolve(stdout)
            else {
                const err = new Error(`tmux ${args.join(' ')} → exit ${code}: ${stderr.trim()}`) as TmuxError
                err.code = code ?? -1
                err.stderr = stderr
                reject(err)
            }
        })
    })
}

export interface SessionInfo {
    name: string
    attached: boolean
    windows: number
}

export async function hasSession(name: string): Promise<boolean> {
    try {
        await run(['has-session', '-t', name])
        return true
    } catch {
        return false
    }
}

export async function listSessions(): Promise<SessionInfo[]> {
    try {
        const out = await run(['list-sessions', '-F', '#{session_name}\t#{session_attached}\t#{session_windows}'])
        return out.trim().split('\n').filter(Boolean).map(line => {
            const [name, attached, windows] = line.split('\t')
            return { name, attached: attached === '1', windows: Number(windows) }
        })
    } catch (e) {
        const err = e as TmuxError
        if (/no server running|no sessions/i.test(err.stderr || '')) return []
        throw e
    }
}

export async function sendKeys(session: string, text: string, { literal = true }: { literal?: boolean } = {}): Promise<void> {
    const args = ['send-keys', '-t', session]
    if (literal) args.push('-l')
    args.push(text)
    await run(args)
}

export async function sendEnter(session: string): Promise<void> {
    await run(['send-keys', '-t', session, 'Enter'])
}

export async function sendSpecialKey(session: string, key: string): Promise<void> {
    await run(['send-keys', '-t', session, key])
}

export async function capturePane(session: string, { lines = 50, withEscapes = false }: { lines?: number; withEscapes?: boolean } = {}): Promise<string> {
    const args = ['capture-pane', '-p', '-t', session, '-S', `-${lines}`]
    if (withEscapes) args.push('-e')
    return await run(args)
}

export async function pipePaneStart(session: string, command: string): Promise<void> {
    try { await run(['pipe-pane', '-t', session]) } catch {}
    await run(['pipe-pane', '-O', '-t', session, command])
}

export async function pipePaneStop(session: string): Promise<void> {
    try { await run(['pipe-pane', '-t', session]) } catch {}
}

export async function newSession(name: string, { cwd, command = 'claude' }: { cwd?: string; command?: string } = {}): Promise<void> {
    const args = ['new-session', '-d', '-s', name]
    if (cwd) args.push('-c', cwd)
    args.push(command)
    await run(args)
}

export async function killSession(name: string): Promise<void> {
    await run(['kill-session', '-t', name])
}

export async function paneCwd(session: string): Promise<string> {
    const out = await run(['display-message', '-p', '-t', session, '#{pane_current_path}'])
    return out.trim()
}
