# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install            # installs typescript + @types/node (no runtime deps)
npm run build          # tsc → dist/
npm test               # tsc && runs the mini-runner against compiled tests
npx tsc --noEmit       # type-check only

# Run the compiled daemon / CLI (production form)
node dist/bridge.js daemon
node dist/bridge.js init     # interactive bot-token / chat-id / thread-id setup
node dist/bridge.js status
node dist/bridge.js logs     # tail journalctl --user -u claude-bridge.service

# systemd user service (Linux only)
./scripts/install.sh         # substitutes node + bridge paths into the unit template
```

There is **no** dev-mode runner that executes `.ts` directly — every code change requires `npm run build` (or `npm test`, which rebuilds). The CLI never reads `.ts` files.

Run a single test by passing only one compiled file to the runner:

```bash
tsc && node dist/test/_runner.js dist/test/parser.test.js
```

## Architecture

End-to-end data flow:

```
Claude TUI ── tmux pipe-pane ──> FIFO ──> fs.ReadStream
                                              │
                                              ▼
                                          Streamer ── Sink ──> TelegramClient ── HTTPS ──> Bot API
                                              ▲                                                │
                                              │                                                ▼
                                         tmux send-keys <── dispatcher <── routeUpdate <── getUpdates
```

One Node process owns the loop. `runDaemon` in `lib/daemon.ts` wires it; everything else is a leaf.

**Module responsibilities** (single-purpose, no barrels):

- `bridge.ts` — CLI dispatcher (`daemon | init | status | logs | new | attach | help`). The `daemon` subcommand is what systemd launches.
- `lib/daemon.ts` — owns `BridgeState`, builds the `Sink`, the `Ctx`, and the Telegram long-poll loop. Restores the previously attached session on restart from `state.json`.
- `lib/dispatcher.ts` — pure routing: `routeUpdate` → `routeMessage` / `routeCallback` → command handlers. Reads `Ctx` only; never touches tmux directly except through the imported helpers.
- `lib/streamer.ts` — debounces and throttles output bytes into Telegram `sendMessage` / `editMessageText`. Has a `Clock` injection point so tests can drive time without `setTimeout`.
- `lib/parser.ts` — `stripAnsi` + `detectPrompt`. `detectPrompt` returns a discriminated union `{ type: 'free' | 'approve' | 'menu' }`; downstream code narrows on `.type`.
- `lib/telegram.ts` — raw `https` request wrapper, typed `TelegramClient`, error-shape guards (`isRateLimit`, `isInvalidToken`, etc.). Constructor optionally takes a `defaultThreadId` that gets attached to every outbound `sendMessage`.
- `lib/tmux.ts` — `spawn('tmux', ...)` wrappers. All sync IPC.
- `lib/fifo.ts` — POSIX named-pipe helpers. `openReadStream` opens with `O_NONBLOCK` so the daemon never blocks waiting for a tmux writer.
- `lib/config.ts` — `Config` / `State` / `Defaults` schemas + JSON load/save. Config lives in `~/.config/claude-bridge/`. `state.json` records `attached_session` and `last_update_id` so the daemon can reattach + resume polling without losing updates across restarts.

## Project-wide constraints

- **Node 14+** is a hard floor — the deployment target uses Node 14. `@types/node` is pinned to `^14.18` so contributors can't reach for Node 16+ APIs accidentally. Avoid `Array.prototype.at`, `Promise.any`, `String.prototype.replaceAll`, `structuredClone`, `node:` prefix imports, top-level `await`.
- **ESM via NodeNext** — every internal import keeps the `.js` extension even though the source is `.ts` (`import { stripAnsi } from './parser.js'`). TS-ESM convention; do not write `.ts` in import specifiers.
- **Zero runtime dependencies.** `dependencies` in `package.json` is intentionally empty. Adding one requires good reason.
- **Strict TypeScript** — `strict: true`. Type errors block the build.
- **Platform**: production target is Linux + systemd. macOS works for the daemon (tmux + mkfifo exist) but `scripts/install.sh` is systemd-only. Windows native is unsupported (no tmux, no POSIX FIFO).

## Test pattern

Tests use a tiny in-repo runner (`test/_runner.ts`) — no `node:test`, no external framework. Tests call `test(name, fn)` and the runner imports each compiled `.js` file and runs them sequentially. To inject time/clocks/sinks, tests build plain objects matching the exported interfaces (`Sink`, `Clock`) — see `test/streamer.test.ts` for the pattern. Fixtures live in `test/fixtures/` and are loaded via cwd-relative paths.

## Documentation

`docs/specs/` contains the original design spec; `docs/plans/` contains the original implementation plan. Both are historical artifacts (frozen) — they reflect the initial `.mjs` design and won't track refactors. Read them for the *why* behind architectural decisions, not the current state.
