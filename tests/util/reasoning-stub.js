// Test stub for SillyTavern's reasoning.js.
//
// Importing it for real pulls in openai.js, popup.js, the slash-commands
// tree, macros/macro-system.js, i18n.js and more — a large, DOM-dependent
// graph (svg-inject touches `window` at import time) for one function.
// live-direction.js reaches exactly one binding from this module.
//
// Deliberately minimal: an inert value with no behaviour, following the same
// pattern as script-stub.js. No current test exercises reasoning extraction
// itself; widen this stub (or route the caller through st-context.js instead)
// if one starts to.

export function extractReasoningFromData() { return ''; }
