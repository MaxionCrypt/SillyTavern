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
// requestDirection compiled and would have sent, with no network
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
import {
    createVariableValue,
    updateMechanicsProfile,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/variables-store.js';
import { addressRequestsByName } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/live-direction.js';
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
        // right after requestDirection has already compiled the
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

/**
 * Real Variables in the fixture Timeline.
 *
 * Without these, `resolveVariableContext` short-circuits on
 * "This Timeline has no Variables" and NO test in either suite ever puts a
 * Variable through the real Director-prompt path — which is precisely how the
 * `[v1]` prefix survived seven task reviews. `always` retrieval means they
 * surface with no lore links, no vector index and no connection.
 *
 * Two distinct names make wrong-record addressing reachable (a positional ref
 * would land on whichever ranked first); the duplicated pair makes design §3's
 * name-collision edge reachable in the same pass.
 */
function seedVariables() {
    updateMechanicsProfile({ enabled: true });
    const always = { mode: 'always' };
    createVariableValue({
        timelineId: scene.timelineId, name: "Aiden's HP", valueType: 'number', value: 12,
        description: 'capacity to withstand injury', authority: 'world', retrieval: always,
        subvalues: [{ key: 'maximum', label: 'Maximum', type: 'number', value: 20, role: 'maximum' }],
    });
    createVariableValue({
        timelineId: scene.timelineId, name: 'Faction Heat', valueType: 'number', value: 3,
        description: 'how hard the syndicate is looking', authority: 'world', retrieval: always,
    });
    createVariableValue({
        timelineId: scene.timelineId, name: 'Resolve', valueType: 'number', value: 5,
        description: "Aiden's nerve", authority: 'world', retrieval: always,
    });
    createVariableValue({
        timelineId: scene.timelineId, name: 'Resolve', valueType: 'number', value: 9,
        description: "the antagonist's nerve", authority: 'world', retrieval: always,
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
 * requestDirection compiled and would have sent to the network — captured via
 * the test adapter seam, never an actual call.
 *
 * The adapter answers with a minimal well-formed Director reply rather than
 * with nothing, so the pass still fails where these tests say it does (at
 * performer resolution, with the empty cast above) instead of failing earlier
 * on an empty reply.
 */
async function captureRealCompiledPrompt() {
    let captured = null;
    setLiveDirectionTestAdapters({
        requestDirection: async ({ prompt }) => {
            captured = prompt;
            return '[note] parity fixture.';
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
    // requestDirection and previewDirectorPrompt — each resolve their
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

// ------------------------------------------------------ real Variables, real path
//
// Everything below drives an actual Variable from the store, through
// resolveVariableContext / buildMechanicalSnapshot / buildDirectionSources /
// compilePromptRecipe, and asserts on the text the Director would receive —
// not on a value the implementation just set, and not on a hand-written
// fixture standing in for the producer's output.

test('a real Variable reaches the Director by name, with no positional ref anywhere in the prompt', async () => {
    seedVariables();
    const real = await captureRealCompiledPrompt();
    const text = real.map((message) => message.content).join('\n\n');

    expect(text).toContain("Aiden's HP: 12");
    expect(text).toContain('Maximum: 20');
    expect(text).toContain('Meaning: capacity to withstand injury');
    expect(text).toContain('Faction Heat: 3');
    // The defect this suite exists to catch: `[v1] Aiden's HP: 12` printed
    // directly beneath "Address each one by the exact name below".
    expect(text).not.toMatch(/\[v\d+\]/);
    expect(text).not.toMatch(/\bv[1-9]\b/);
    expect(text).not.toMatch(/\bg[1-9]\b/);
});

test('a duplicated name is shown as unaddressable rather than silently guessed at', async () => {
    seedVariables();
    const real = await captureRealCompiledPrompt();
    const text = real.map((message) => message.content).join('\n\n');

    expect(text).toContain('Resolve');
    expect(text).toMatch(/duplicated in this Timeline and cannot be addressed: Resolve/);
});

test('a ref-shaped request does not resolve against the maps a real pass actually built', async () => {
    seedVariables();
    // The snapshot the preview returns is the same object a real pass hands to
    // executeDirectionRequests — its variableRefs Map and addressBook are
    // production values, not fixtures.
    const { snapshot } = await previewDirectorPrompt(scene);
    const { variableRefs, addressBook } = snapshot.mechanics;
    expect(variableRefs.size).toBeGreaterThan(0);

    const byRef = addressRequestsByName(
        [{ id: 'r1', capability: 'variable.adjust', arguments: { variableRef: 'v1', delta: -3 } }],
        addressBook, variableRefs, snapshot.mechanics.goalRefs,
    );
    expect(byRef.variableRefs.get('v1')).toBeUndefined();
    expect(byRef.unresolvedReasons[0]).toMatch(/not advertised/i);

    // The same call with the name the prompt actually advertised must work,
    // so this is proving refusal-of-refs and not refusal-of-everything.
    const byName = addressRequestsByName(
        [{ id: 'r1', capability: 'variable.adjust', arguments: { variableRef: "Aiden's HP", delta: -3 } }],
        addressBook, variableRefs, snapshot.mechanics.goalRefs,
    );
    expect(byName.variableRefs.get("Aiden's HP")).toBeTruthy();
    expect(byName.unresolvedReasons).toEqual([]);

    // And the duplicated name is refused by name too — the positional route
    // that used to rescue it is gone.
    const duplicated = addressRequestsByName(
        [{ id: 'r1', capability: 'variable.adjust', arguments: { variableRef: 'Resolve', delta: 1 } }],
        addressBook, variableRefs, snapshot.mechanics.goalRefs,
    );
    expect(duplicated.variableRefs.get('Resolve')).toBeUndefined();
    expect(duplicated.unresolvedReasons[0]).toMatch(/more than one record/i);
});
