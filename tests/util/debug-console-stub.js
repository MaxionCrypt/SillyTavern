// Test stub for Remodel's own debug-console.js.
//
// The real module renders the Debug workspace and wires
// `window.addEventListener(...)` at module load time (a hard dependency on a
// DOM global that does not exist under Node), on top of a 600+ line UI it
// takes no part in verifying here. live-direction.js reaches exactly one
// binding from it: the journal function every code path already wraps in a
// try/catch, because "diagnostics must never be able to break a generation."
//
// Records rather than discards, because some behaviour this codebase promises
// is ONLY observable as a journal entry: design §3 requires that an
// unparseable state tail costs the turn its state changes and produces "a
// journal entry" — with an inert stub, a test could only assert the absence of
// a change, which an implementation that silently dropped the whole reply
// would also satisfy.

let events = [];

export function recordDebugEvent(category, type, detail = {}, options = {}) {
    events.push({ category, type, detail, ...options });
}

/** Test-only: every journal entry recorded since the last clear. */
export function __getDebugEvents() {
    return [...events];
}

export function __clearDebugEvents() {
    events = [];
}
