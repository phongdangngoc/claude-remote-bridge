// Minimal test runner for Node 14 (no node:test).
// Tests register via `test(name, fn)`; this module collects them and
// runs sequentially when imported as the entry point.
//
// No top-level await: TLA only landed unflagged in Node 14.8, and the
// target floor here is 14.0.

const tests = []
let registering = true

export function test(name, fn) {
    if (!registering) throw new Error(`test() called after run started: ${name}`)
    tests.push({ name, fn })
}

async function run(files) {
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
            console.error(err && err.stack ? err.stack : err)
        }
    }
    console.log(`\n${passed} passed, ${failed} failed`)
    if (failed > 0) process.exit(1)
}

// When invoked as entry point, treat CLI args as test files to load.
function isEntryPoint() {
    const argv1 = process.argv[1] || ''
    const normalised = argv1.replace(/\\/g, '/')
    return import.meta.url.endsWith(normalised)
}

if (isEntryPoint()) {
    import('url').then(({ pathToFileURL }) => import('path').then(path => {
        const files = process.argv.slice(2).map(f => pathToFileURL(path.resolve(f)).href)
        if (files.length === 0) {
            console.error('usage: node test/_runner.mjs <test-file...>')
            process.exit(2)
        }
        return run(files)
    })).catch(err => { console.error(err); process.exit(1) })
}
