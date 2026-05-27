// Minimal test runner for Node 14 (no node:test).
// Tests register via `test(name, fn)`; this module collects them and
// runs sequentially when invoked as the entry point with test files
// passed as CLI arguments.
//
// No top-level await: TLA only landed unflagged in Node 14.8, and the
// target floor here is 14.0.

export type TestFn = () => void | Promise<void>

interface RegisteredTest {
    name: string
    fn: TestFn
}

const tests: RegisteredTest[] = []
let registering = true

export function test(name: string, fn: TestFn): void {
    if (!registering) throw new Error(`test() called after run started: ${name}`)
    tests.push({ name, fn })
}

async function run(files: string[]): Promise<void> {
    for (const f of files) {
        await import(f)
    }
    registering = false
    let passed = 0
    let failed = 0
    for (const t of tests) {
        try {
            await t.fn()
            passed++
            console.log(`ok - ${t.name}`)
        } catch (err) {
            failed++
            console.error(`not ok - ${t.name}`)
            const e = err as Error
            console.error(e && e.stack ? e.stack : e)
        }
    }
    console.log(`\n${passed} passed, ${failed} failed`)
    if (failed > 0) process.exit(1)
}

// When invoked as entry point, treat CLI args as test files to load.
function isEntryPoint(): boolean {
    const argv1 = process.argv[1] || ''
    const normalised = argv1.replace(/\\/g, '/')
    return import.meta.url.endsWith(normalised)
}

if (isEntryPoint()) {
    import('url').then(({ pathToFileURL }) => import('path').then(path => {
        const files = process.argv.slice(2).map(f => pathToFileURL(path.resolve(f)).href)
        if (files.length === 0) {
            console.error('usage: node dist/test/_runner.js <test-file...>')
            process.exit(2)
        }
        return run(files)
    })).catch(err => { console.error(err); process.exit(1) })
}
