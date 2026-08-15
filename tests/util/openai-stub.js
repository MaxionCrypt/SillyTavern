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
