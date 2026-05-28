import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import { spawn } from 'child_process'

function runMkfifo(p: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn('mkfifo', [p], { stdio: 'ignore' })
        child.on('error', reject)
        child.on('close', (code) => {
            if (code === 0) resolve()
            else reject(new Error(`mkfifo exit ${code}`))
        })
    })
}

export async function ensureFifoDir(dir: string): Promise<void> {
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 })
}

export async function createFifo(fifoPath: string): Promise<void> {
    try { await fsp.unlink(fifoPath) } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    }
    await runMkfifo(fifoPath)
}

export function openReadStream(fifoPath: string): fs.ReadStream {
    // O_RDWR on a FIFO: opens without blocking, and the kernel never reports
    // EAGAIN/EOF on the read side while we hold the writer end ourselves —
    // which prevents fs.ReadStream from self-destructing on initial read.
    const fd = fs.openSync(fifoPath, fs.constants.O_RDWR)
    return fs.createReadStream('', { fd, autoClose: true, encoding: undefined })
}

export async function unlinkFifo(fifoPath: string): Promise<void> {
    try { await fsp.unlink(fifoPath) } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    }
}

export function fifoPathFor(dir: string, session: string): string {
    return path.join(dir, `${session.replace(/[^A-Za-z0-9._-]/g, '_')}.fifo`)
}
