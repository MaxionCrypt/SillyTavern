// Test stub for SillyTavern's reasoning.js.
//
// Importing it for real pulls in openai.js, popup.js, the slash-commands
// tree, macros/macro-system.js, i18n.js and more — a large, DOM-dependent
// graph (svg-inject touches `window` at import time) for one function.
// story-stream.js reaches exactly one binding from this module.
//
// Implements ONLY the OpenAI-compatible default branch of the real function
// (reasoning.js:139-141, shared by CUSTOM, DeepSeek, xAI, OpenRouter and
// most others): `choices[0].message.reasoning_content ?? .reasoning`. The real
// function switches on `chat_completion_source` and also handles Claude's
// `thinking` parts and Gemini's thought parts — which is exactly why callers
// must delegate to it rather than re-deriving the list.
//
// What a test using this stub can prove: that the caller hands core the
// unmodified response object and returns what core gives back. What it cannot
// prove: that core's per-provider extraction is right. That is core's, and it
// is not this suite's to assert.

export function extractReasoningFromData(data) {
    return data?.choices?.[0]?.message?.reasoning_content
        ?? data?.choices?.[0]?.message?.reasoning
        ?? '';
}
