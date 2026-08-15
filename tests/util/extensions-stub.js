// Test stub for SillyTavern's scripts/extensions.js.
//
// Importing it for real pulls in popup.js, templates.js, user.js, i18n.js and
// more — a large, DOM-dependent graph (popup rendering touches `window` via
// svg-inject at import time). variables-vector.js reaches exactly one
// binding from this module, to read another extension's settings.
//
// Anchored to the exact three-level-up specifier Remodel's own files use
// (matching the precedent set for openai.js in prompt-studio.js): there are
// two files named extensions.js in this repo (this one, and
// src/endpoints/extensions.js on the server side), so a bare basename suffix
// would risk capturing the wrong one if anything ever imported that too.
//
// Deliberately minimal: an inert value with no behaviour, following the same
// pattern as script-stub.js.

export const extension_settings = {};
