// Test stub for SillyTavern's root script.js module.
//
// script.js is the application entry point: importing it for real pulls in
// the DOM, the macro engine, and dozens of other browser-only modules that
// do not exist under Node (see e.g. macros/engine/MacroEnvBuilder.js, which
// imports '/scripts/utils.js' as an absolute browser-root path). Most
// Remodel modules avoid this entirely by going through the st-context.js
// bridge (see st-context-stub.js) instead of importing script.js directly.
// This stub exists for the modules that don't — currently prompt-studio.js.
//
// Deliberately minimal: only the bindings Remodel code actually reaches,
// as inert values with no behaviour. If a future test needs this stub to
// do more than hold a value, that's a signal the module under test should
// be reaching through st-context.js instead of importing script.js
// directly — widen st-context.js/its stub, don't grow this one.

export function createRawPrompt() { return ''; }

export const eventSource = {
    on() {},
    once() {},
    off() {},
    removeListener() {},
    emit() {},
};

// Every SillyTavern event type is just a string key looked up by name; an
// echo Proxy stands in for the whole event_types.* catalogue without this
// stub having to enumerate whichever keys a given caller reaches.
export const event_types = new Proxy({}, { get: (_target, key) => String(key) });

export const main_api = 'openai';
export const name1 = 'User';
export const name2 = 'Character';

export function saveSettingsDebounced() {}

export function substituteParams(text) { return text == null ? '' : String(text); }

// live-direction.js's own bindings. Values copied verbatim from script.js
// where they are plain constants (cheap and removes any drift risk); the
// functions stay inert no-ops.
export const extension_prompt_types = {
    NONE: -1,
    IN_PROMPT: 0,
    IN_CHAT: 1,
    BEFORE_PROMPT: 2,
};

export const extension_prompt_roles = {
    SYSTEM: 0,
    USER: 1,
    ASSISTANT: 2,
};

export let online_status = 'no_connection';

/** Test-only: flips the connection gate live-direction.js checks before it will begin a pass. */
export function __setOnlineStatus(value) {
    online_status = value;
}

export async function sendMessageAsUser() {}

export function setExtensionPrompt() {}

// variables-vector.js's binding, for its cache-key request headers.
export function getRequestHeaders() { return {}; }
