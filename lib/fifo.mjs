import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import { spawn } from 'child_process'

function runMkfifo(p) {
    return new Promise((resolve, reject) => {
        const child = spawn('mkfifo', [p], { stdio: 'ignore' })
        child.on('error', reject)
        child.on('close', (code) => {
            if (code === 0) resolve()
            else reject(new Error(`mkfifo exit ${code}`))
        })
    })
}

export async function ensureFifoDir(dir) {
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 })
}

export async function createFifo(fifoPath) {
    // Idempotent: remove stale FIFO from prev run, then mkfifo
    try { await fsp.unlink(fifoPath) } catch (e) {
        if (e.code !== 'ENOENT') throw e
    }
    await runMkfifo(fifoPath)
}

export function openReadStream(fifoPath) {
    // O_NONBLOCK so open doesn't block waiting for a writer
    const fd = fs.openSync(fifoPath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)
    return fs.createReadStream(null, { fd, autoClose: true, encoding: null })
}

export async function unlinkFifo(fifoPath) {
    try { await fsp.unlink(fifoPath) } catch (e) {
        if (e.code !== 'ENOENT') throw e
    }
}

export function fifoPathFor(dir, session) {
    return path.join(dir, `${session.replace(/[^A-Za-z0-9._-]/g, '_')}.fifo`)
}
