// The Director preview's entire value proposition is that it can never drift
// from what a real direction pass actually compiles and sends — the recipe
// resolution, buildDirectionSources call, and compilePromptRecipe call are
// meant to be literally the same code (compileDirectorPrompt in
// live-direction.js), reached from two different callers. This suite proves
// that by driving BOTH callers independently and comparing what each one
// produced — not by asserting on a value either side just set.
//
// The real side is driven through requestNextDirection (a real, if minimal,
// direction pass) with setLiveDirectionTestAdapters standing in for the
// network call — the stub adapter receives the exact `prompt` array
// requestDirectionEnvelope compiled and would have sent, with no network
// call and no risk of a real generation. The preview side is
// previewDirectorPrompt itself. Both read from the same fixture Scene, cast,
// and composer draft, so any divergence between the two call sites — not
// between two different inputs — is what would fail these assertions.
import { test, expect, jest, beforeEach, afterEach } from '@jest/globals';
import {
    initLiveDirection,
    setLiveDirectionTestAdapters,
    requestNextDirection,
    previewDirectorPrompt,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/live-direction.js';
import {
    createPromptRecipe,
    createPromptBlock,
    setActivePromptRecipe,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/prompt-studio-store.js';
import { __setExtensionSettings } from './util/st-context-stub.js';
import { __setOnlineStatus } from './util/script-stub.js';

// requestNextDirection's autonomous action is a fixed string a caller cannot
// override. previewDirectorPrompt instead reads the action from the composer
// draft hook — so for this to be a fair "would these two compile the same
// thing" comparison rather than a comparison of two different actions, both
// sides are given the same text.
const AUTONOMOUS_ACTION = '[Continue the scene from accepted history.]';

const scene = Object.freeze({
    id: 'scene-parity',
    timelineId: 'timeline-parity',
    title: 'Parity Scene',
    mode: 'roleplay',
    staging: 'directed',
    liveDirection: { enabled: true, directorRef: null, narratorRef: null },
});

function wireHooks() {
    initLiveDirection({
        getActiveScene: () => scene,
        // An empty cast is deliberate: it makes resolvePerformer fail fast,
        // right after requestDirectionEnvelope has already compiled the
        // prompt and handed it to the stub adapter below — which is the only
        // part these tests need. No cast/persona content also keeps the
        // mechanics slice identical between the two paths without needing to
        // fake any Variable/Goal data.
        getCast: () => [],
        getPersona: () => null,
        ensureSceneReady: async () => true,
        getComposerDraft: () => AUTONOMOUS_ACTION,
        clearComposer: () => {},
        sendNormally: () => {},
        onStateChange: () => {},
        onSettled: () => {},
        onFailure: () => {},
    });
}

let consoleErrorSpy;

beforeEach(() => {
    __setExtensionSettings({});
    __setOnlineStatus('connected');
    wireHooks();
    // The empty-cast pass above is expected to fail at performer resolution
    // and logs that failure via console.error (live-direction.js's
    // directionFailure). Silence it so an intentional, asserted-around
    // failure path doesn't read as test breakage in the suite's output.
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    consoleErrorSpy.mockRestore();
    setLiveDirectionTestAdapters(null);
});

/**
 * Drives one real direction pass and returns the exact `prompt` array
 * requestDirectionEnvelope compiled and would have sent to the network —
 * captured via the test adapter seam, never an actual call.
 */
async function captureRealCompiledPrompt() {
    let captured = null;
    setLiveDirectionTestAdapters({
        requestDirection: async ({ prompt }) => {
            captured = prompt;
            return {};
        },
    });
    await requestNextDirection(scene);
    return captured;
}

test('the default seeded Director recipe compiles identically for a real pass and for the preview', async () => {
    const real = await captureRealCompiledPrompt();
    const preview = await previewDirectorPrompt(scene);

    expect(real).not.toBeNull();
    expect(real.length).toBeGreaterThan(0);
    expect(preview.usedFallback).toBe(false);
    // Two genuinely independent call sites — beginDirection's real
    // requestDirectionEnvelope and previewDirectorPrompt — each resolve their
    // own recipe, build sources from their own snapshot, and compile. If
    // compileDirectorPrompt's extraction ever let the two drift apart, this
    // is where it would show.
    expect(preview.prompt).toEqual(real);
});

test('a Director recipe missing its protocol block falls back identically on both paths', async () => {
    const broken = createPromptRecipe({
        name: 'Broken Director',
        mode: 'director',
        apiType: 'chat',
        blocks: [createPromptBlock({ kind: 'message', role: 'system', content: 'No protocol block here.' })],
    });
    setActivePromptRecipe('director', 'chat', broken.id);

    const real = await captureRealCompiledPrompt();
    const preview = await previewDirectorPrompt(scene);

    // Confirms this is genuinely exercising the fallback, not an accidental
    // empty-array match.
    expect(real.length).toBeGreaterThan(0);
    expect(real.some((message) => message.content.includes('hidden director'))).toBe(true);
    expect(preview.usedFallback).toBe(true);
    expect(preview.prompt).toEqual(real);
});
