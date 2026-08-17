// The Director preview's by-source panel exists because compilePromptRecipe
// merges adjacent same-role blocks and then throws block identity away: the
// default Director recipe's five authored blocks arrive as two messages, and
// `messages` records only {role, content}. The trace hands that accounting
// back.
//
// Two things have to hold, and neither may be taken on faith:
//
//   1. The trace has to actually account for the messages that were produced.
//      Every assertion below reconstructs the compiled messages FROM the trace
//      and compares against the messages the compiler returned — so a trace
//      that mislabels which message a block merged into, drops a block, or
//      reports text that is not what was appended, fails. Nothing here is
//      compared against a hand-written expected shape; the expected values are
//      read back out of the recipe and the compiler's own output.
//
//   2. Asking for the trace must not change `messages`. That is the property
//      the whole preview rests on — the preview and the real request compile
//      through this one function and must agree byte for byte. It is checked
//      by compiling the same recipe and sources twice, once each way, and
//      deep-comparing.
import { test, expect, beforeEach } from '@jest/globals';
import { compilePromptRecipe } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/prompt-studio.js';
import {
    createPromptRecipe,
    createPromptBlock,
    getActivePromptRecipe,
    initializePromptStudioStore,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/prompt-studio-store.js';
import { __setExtensionSettings } from './util/st-context-stub.js';

beforeEach(() => {
    __setExtensionSettings({});
    initializePromptStudioStore();
});

/**
 * Rebuilds the compiled messages using only the trace.
 *
 * Contributions are appended in the order they were made — block order, then
 * part order within a block — which is exactly the order appendMessage saw
 * them, so joining each message's contributions with the same separator the
 * merge uses has to reproduce the merged content if the trace is honest.
 */
function rebuildFromTrace(trace) {
    const byMessage = [];
    for (const entry of trace) {
        for (const part of entry.parts) {
            if (!byMessage[part.messageIndex]) byMessage[part.messageIndex] = { role: part.role, chunks: [] };
            byMessage[part.messageIndex].chunks.push(part.content);
        }
    }
    return byMessage.map((message) => ({ role: message.role, content: message.chunks.join('\n\n') }));
}

/**
 * Sources for the seeded Director recipe, distinct enough to be traceable.
 *
 * `directorNotebook` is a FUNCTION, matching what `buildDirectionSources`
 * actually returns for it — it is the one source resolved from the block's own
 * `settings`, and a plain string here would let the trace pass while the real
 * (function-form) resolution went untraced.
 */
const directorSources = Object.freeze({
    directionProtocol: 'PROTOCOL: reply with an envelope.',
    directorCard: 'CARD: the Director judges, never speaks.',
    mechanicsSkill: 'MECHANICS: two Variables are in play.',
    worldInfoBefore: 'LORE BEFORE: the Guild runs Marrow Street.',
    worldInfoAfter: 'LORE AFTER: the fog comes off the water at four.',
    worldInfoExamples: 'LORE EXAMPLES: <START>',
    worldInfoDepth: 'LORE AT DEPTH: the gate was forced twice.',
    directorNotebook: (settings) => `NOTEBOOK: the last ${settings?.depth} turns, secrets included.`,
    directorSnapshot: 'SNAPSHOT: the scene so far.',
});

test('the seeded Director recipe traces five authored blocks into the two messages it actually sends', () => {
    const recipe = getActivePromptRecipe('director', 'chat');
    expect(recipe).toBeTruthy();

    const compiled = compilePromptRecipe(recipe, directorSources, { trace: true });

    // The premise of the whole panel: more authored blocks than sent messages.
    // Read from the recipe, not asserted as a literal, so this still describes
    // the seeded recipe if it gains or loses a block.
    const enabled = recipe.blocks.filter((block) => block.enabled);
    expect(compiled.trace).toHaveLength(enabled.length);
    expect(compiled.messages.length).toBeLessThan(enabled.length);
    expect(compiled.messages.length).toBeGreaterThan(1);

    // The accounting itself.
    expect(rebuildFromTrace(compiled.trace)).toEqual(compiled.messages);

    // Every entry names the block it came from and lands in a real message.
    expect(compiled.trace.map((entry) => entry.blockId)).toEqual(enabled.map((block) => block.id));
    expect(compiled.trace.map((entry) => entry.sourceKey)).toEqual(
        enabled.map((block) => (block.kind === 'source' ? block.sourceKey : null)),
    );
    for (const entry of compiled.trace) {
        expect(entry.label).toEqual(expect.any(String));
        expect(entry.label.length).toBeGreaterThan(0);
        expect(entry.messageIndex).toBeGreaterThanOrEqual(0);
        expect(entry.role).toBe(compiled.messages[entry.messageIndex].role);
        // Its own text before merging — present in, but generally shorter
        // than, the message it was folded into.
        expect(compiled.messages[entry.messageIndex].content).toContain(entry.text);
    }

    // And the merge is genuinely visible: at least one block was appended to a
    // message another block had already opened.
    expect(compiled.trace.some((entry) => entry.merged)).toBe(true);
});

test('asking for the trace does not change the messages that get compiled', () => {
    const recipe = getActivePromptRecipe('director', 'chat');

    const withTrace = compilePromptRecipe(recipe, directorSources, { trace: true });
    const withoutTrace = compilePromptRecipe(recipe, directorSources);

    expect(withoutTrace.trace).toBeUndefined();
    expect(withTrace.trace).toBeTruthy();
    // The load-bearing one. If the trace path ever compiles differently — a
    // separator, a trim, an extra marker, a skipped merge — this fails.
    expect(withTrace.messages).toEqual(withoutTrace.messages);
    expect(withTrace.text).toBe(withoutTrace.text);
    // Guards the guard: a compile that produced nothing would satisfy the
    // comparison above vacuously.
    expect(withoutTrace.messages.length).toBeGreaterThan(1);
});

test('a block whose source resolves to nothing is traced as having contributed nothing, not dropped', () => {
    const recipe = createPromptRecipe({
        name: 'Sparse Director',
        mode: 'director',
        apiType: 'chat',
        blocks: [
            createPromptBlock({ kind: 'source', role: 'system', sourceKey: 'directionProtocol' }),
            createPromptBlock({ kind: 'source', role: 'system', sourceKey: 'directorCard' }),
            createPromptBlock({ kind: 'source', role: 'user', sourceKey: 'directorSnapshot' }),
        ],
    });

    const compiled = compilePromptRecipe(recipe, {
        directionProtocol: 'PROTOCOL',
        directorCard: '',
        directorSnapshot: 'SNAPSHOT',
    }, { trace: true });

    expect(compiled.trace).toHaveLength(3);
    const empty = compiled.trace[1];
    expect(empty.sourceKey).toBe('directorCard');
    expect(empty.messageIndex).toBe(-1);
    expect(empty.parts).toEqual([]);
    expect(empty.text).toBe('');
    // The two that did contribute still account for everything sent.
    expect(rebuildFromTrace(compiled.trace)).toEqual(compiled.messages);
    expect(compiled.messages).toHaveLength(2);
});

test('a disabled block is absent from the trace, exactly as it is absent from the messages', () => {
    const recipe = createPromptRecipe({
        name: 'Half-off Director',
        mode: 'director',
        apiType: 'chat',
        blocks: [
            createPromptBlock({ kind: 'source', role: 'system', sourceKey: 'directionProtocol' }),
            createPromptBlock({ kind: 'message', role: 'system', content: 'Silenced style note.', enabled: false }),
            createPromptBlock({ kind: 'source', role: 'user', sourceKey: 'directorSnapshot' }),
        ],
    });

    const compiled = compilePromptRecipe(recipe, { directionProtocol: 'PROTOCOL', directorSnapshot: 'SNAPSHOT' }, { trace: true });

    expect(compiled.trace).toHaveLength(2);
    expect(compiled.trace.some((entry) => entry.text.includes('Silenced'))).toBe(false);
    expect(rebuildFromTrace(compiled.trace)).toEqual(compiled.messages);
});

test('a source that resolves to several messages is accounted for across every message it straddles', () => {
    const recipe = createPromptRecipe({
        name: 'Multi Story',
        mode: 'story',
        apiType: 'chat',
        blocks: [
            createPromptBlock({ kind: 'message', role: 'system', content: 'Opening system line.' }),
            createPromptBlock({ kind: 'source', role: 'system', sourceKey: 'chatHistory' }),
            createPromptBlock({ kind: 'message', role: 'user', content: 'Closing user line.' }),
        ],
    });

    const compiled = compilePromptRecipe(recipe, {
        chatHistory: {
            messages: [
                { role: 'system', content: 'History preamble.' },
                { role: 'user', content: 'They spoke first.' },
                { role: 'assistant', content: 'And were answered.' },
            ],
        },
    }, { trace: true });

    const history = compiled.trace[1];
    // One block, three contributions, landing in more than one message — the
    // case a single messageIndex could not describe.
    expect(history.parts).toHaveLength(3);
    expect(history.messageIndices.length).toBeGreaterThan(1);
    expect(history.messageIndex).toBe(history.parts[0].messageIndex);
    // The preamble merged into the message the opening line had already
    // started; the rest opened new ones.
    expect(history.parts[0].merged).toBe(true);
    expect(rebuildFromTrace(compiled.trace)).toEqual(compiled.messages);

    // `text` is the block's own resolved text — the figure the panel sizes and
    // the fallback body. Every contribution has to be in it, in order, or the
    // card would understate what the block put into the prompt.
    let cursor = -1;
    for (const part of history.parts) {
        const at = history.text.indexOf(part.content, cursor + 1);
        expect(at).toBeGreaterThan(cursor);
        cursor = at;
    }

    // And this recipe too compiles the same with and without the trace.
    expect(compiled.messages).toEqual(compilePromptRecipe(recipe, {
        chatHistory: {
            messages: [
                { role: 'system', content: 'History preamble.' },
                { role: 'user', content: 'They spoke first.' },
                { role: 'assistant', content: 'And were answered.' },
            ],
        },
    }).messages);
});
