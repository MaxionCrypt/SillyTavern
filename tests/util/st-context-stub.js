// Test stub for SillyTavern's st-context module.
//
// The Remodel Variables store is ordinary pure logic that happens to read and
// write one settings object, but its only door to that object is
// `getContext()` — and the real st-context pulls in script.js, the macro
// engine, and the DOM, none of which exist under Node. Mapping the import to
// this stub lets the migration fixtures exercise the real production code
// instead of a copy of it.
//
// Deliberately minimal: only what the store actually touches. If a future test
// needs more of the context surface, add it here rather than widening the
// store's dependencies.

let settings = {};

export function getContext() {
    return {
        extensionSettings: settings,
        saveSettingsDebounced() { /* no persistence under test */ },
    };
}

/** Install a fresh settings object; returns it so a test can assert on it. */
export function __setExtensionSettings(value) {
    settings = value || {};
    return settings;
}

export function __getExtensionSettings() {
    return settings;
}
