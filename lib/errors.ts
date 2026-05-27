// Safely extract a string from an unknown thrown value.
// Useful in catch blocks where `e` is typed `unknown` under strict TS,
// and a thrown non-Error (string, null, plain object) would otherwise
// render as "undefined" via `(e as Error).message`.
export function errMsg(e: unknown): string {
    if (e instanceof Error) return e.message
    if (typeof e === 'string') return e
    return String(e)
}
