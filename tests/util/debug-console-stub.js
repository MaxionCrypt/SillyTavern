// Test stub for Remodel's own debug-console.js.
//
// The real module renders the Debug workspace and wires
// `window.addEventListener(...)` at module load time (a hard dependency on a
// DOM global that does not exist under Node), on top of a 600+ line UI it
// takes no part in verifying here. live-direction.js reaches exactly one
// binding from it: the journal function every code path already wraps in a
// try/catch, because "diagnostics must never be able to break a generation."
//
// Deliberately minimal: an inert value with no behaviour, following the same
// pattern as script-stub.js.

export function recordDebugEvent() {}
