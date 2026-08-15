// Test stub for SillyTavern's st-context module.
//
// The Remodel Variables store is ordinary pure logic that happens to read and
// write one settings object, but its only door to that object is
// `getContext()` — and the real st-context pulls in script.js, the macro
// engine, and the DOM, none of which exist under Node. Mapping the import to
// this stub lets the migration fixtures exercise the real production code
// instead of a copy of it.
//
// Deliberately minimal: only what the code under test actually touches. If a
// future test needs more of the context surface, add it here rather than
// widening the production modules' dependencies.

let settings = {};

/**
 * One chat, one event bus, for the whole module lifetime.
 *
 * Both must be stable across `__setExtensionSettings`. live-direction.js
 * registers its stream/generation listeners exactly once (the `initialized`
 * guard in initLiveDirection), so replacing the emitter between tests would
 * orphan them; and it reads `getContext().chat` on every call, so a fresh
 * array per call would lose the message a run is revealing into. The chat is
 * emptied in place instead of replaced.
 */
const chat = [];

const listeners = new Map();
const eventSource = {
    on(type, handler) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(handler);
    },
    once(type, handler) {
        const wrapped = (...args) => { eventSource.off(type, wrapped); return handler(...args); };
        eventSource.on(type, wrapped);
    },
    off(type, handler) {
        listeners.set(type, (listeners.get(type) || []).filter((item) => item !== handler));
    },
    removeListener(type, handler) { eventSource.off(type, handler); },
    async emit(type, ...args) {
        for (const handler of [...(listeners.get(type) || [])]) {
            // eslint-disable-next-line no-await-in-loop
            await handler(...args);
        }
    },
};

let savedChatCount = 0;
let stopGenerationCount = 0;

export function getContext() {
    return {
        extensionSettings: settings,
        saveSettingsDebounced() { /* no persistence under test */ },
        chat,
        eventSource,
        eventTypes: new Proxy({}, { get: (_target, key) => String(key) }),
        async getWorldInfoPrompt() { return {}; },
        maxContext: 4096,
        // live-direction.js's run lifecycle: finalizeRunMessage saves, and
        // removes the message outright when nothing was ever accepted.
        async saveChat() { savedChatCount++; },
        async deleteMessage(messageId) {
            const id = Number(messageId);
            if (Number.isInteger(id) && id >= 0 && id < chat.length) chat.splice(id, 1);
        },
        stopGeneration() { stopGenerationCount++; },
    };
}

/** Install a fresh settings object; returns it so a test can assert on it. */
export function __setExtensionSettings(value) {
    settings = value || {};
    chat.length = 0;
    savedChatCount = 0;
    stopGenerationCount = 0;
    return settings;
}

export function __getExtensionSettings() {
    return settings;
}

/** The live chat array, for a test that needs to write a message into it. */
export function __getChat() {
    return chat;
}

/** Fire a SillyTavern event at whatever registered for it. */
export function __emit(type, ...args) {
    return eventSource.emit(type, ...args);
}

export function __getCounters() {
    return { savedChatCount, stopGenerationCount };
}
