// Test stub for SillyTavern's scripts/openai.js module.
//
// Note: there are two files named openai.js in the tree (this one, and
// scripts/extensions/tts/openai.js). The jest.config.json mapping for this
// stub is anchored to the exact relative specifier Remodel modules use
// ('../../../openai.js', all Remodel prompt-related files being flat
// siblings under SillyTavern-Remodel/) rather than a bare "*/openai.js"
// suffix, specifically so it cannot also catch an import of the TTS
// extension's unrelated same-named file.
//
// Deliberately minimal: only the bindings Remodel code actually reaches.

export const oai_settings = {
    prompts: [],
    prompt_order: [],
};

export const promptManager = {
    render() {},
};

/**
 * The Chat Completion transport, as story-stream.js reaches it.
 *
 * A test installs a handler with `__setOpenAIRequestHandler`; with none
 * installed this throws rather than returning something plausible, so a test
 * that reaches the network boundary by accident fails loudly instead of
 * quietly asserting against a stub's invention.
 *
 * The handler returns whatever core would: an async generator FUNCTION when
 * the request streams (core returns `async function* streamData()`, which is
 * why story-stream.js tests `typeof response !== 'function'`), or a plain
 * response object when the provider answered in one piece.
 */
let openAIRequestHandler = null;

export function __setOpenAIRequestHandler(handler) {
    openAIRequestHandler = typeof handler === 'function' ? handler : null;
}

export async function sendOpenAIRequest(type, messages, signal, options = {}) {
    if (!openAIRequestHandler) {
        throw new Error('sendOpenAIRequest was called with no test handler installed — see tests/util/openai-stub.js.');
    }
    return openAIRequestHandler({ type, messages, signal, options });
}
