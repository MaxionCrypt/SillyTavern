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
//
// sendMessageAsUser is the one exception: it has to write into the same chat
// getContext().chat hands out, so it reaches into st-context-stub.js's array
// rather than staying a value with no behaviour. See the note on it below.
import { __getChat } from './st-context-stub.js';

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
export function getMaxResponseTokens() { return 2048; }
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

// Pushes onto the SAME chat array st-context-stub.js hands out through
// getContext().chat — not a private array of this module's own. Task 7 moved
// live-direction.js's call to this function ahead of the Loom round trip
// specifically so the message is already in context.chat by the time the
// snapshot is built, and a test-only no-op here would make that ordering
// untestable: __getChat() would never show the insertion this stub is meant
// to stand in for. Shaped like core's own sendMessageAsUser (script.js) only
// as far as the fields live-direction.js and its tests actually read.
export async function sendMessageAsUser(messageText, messageBias, insertAt = null) {
    const chat = __getChat();
    const message = { name: name1, is_user: true, is_system: false, mes: String(messageText ?? ''), extra: {} };
    if (typeof insertAt === 'number' && insertAt >= 0 && insertAt <= chat.length) {
        chat.splice(insertAt, 0, message);
    } else {
        chat.push(message);
    }
    return message;
}

// Recorded rather than a pure no-op so a test can assert not just THAT a
// caller registered a given key, but WHAT it set it to and in what order —
// load-bearing for proving a value was re-mirrored at the right moment
// relative to some other call, not merely that it was set at some point.
let extensionPromptCalls = [];

export function setExtensionPrompt(key, value, ...rest) {
    extensionPromptCalls.push({ key, value, args: rest });
}

/** Test-only: the most recently set value for `key`, or undefined if it was never set. */
export function __getExtensionPrompt(key) {
    const calls = extensionPromptCalls.filter((call) => call.key === key);
    return calls.length ? calls[calls.length - 1].value : undefined;
}

/** Test-only: every recorded call, in order — for asserting relative timing/ordering. */
export function __getExtensionPromptCalls() {
    return [...extensionPromptCalls];
}

export function __clearExtensionPromptCalls() {
    extensionPromptCalls = [];
}

// variables-vector.js's binding, for its cache-key request headers.
export function getRequestHeaders() { return {}; }
