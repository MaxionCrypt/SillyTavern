// Director history-depth setting.
//
// buildDirectionSnapshot (live-direction.js) used to hand the Director
// `context.chat.slice(-40)` unconditionally — forty raw messages every turn,
// a number that predates the Director's own notebook. The notebook now
// carries continuity itself (`[result]` entries are a running record of what
// actually happened, read back to its author — see directorNotebook), so 40
// messages of raw prose on top of it is mostly redundant. This makes that
// depth user-settable through the mechanism the codebase already has for
// per-block settings (directorNotes' `depth` is the working precedent),
// defaulted lower: `directorSnapshot` in PROMPT_SOURCE_DEFINITIONS.director
// now declares a `history` setting, `min: 0, max: 40, default: 12`.
//
// The wrinkle: buildDirectionSnapshot runs BEFORE compilePromptRecipe (the
// snapshot IS an input to the sources the compile reads), so the setting
// cannot be read out of a compiled block the way a settings-bearing source
// normally would be. resolveDirectorSnapshotHistoryDepth resolves it early,
// straight off the active director recipe's `directorSnapshot` block, and
// buildDirectionSnapshot slices by that number instead of the old 40.
//
// Two layers of coverage below: resolveDirectorSnapshotHistoryDepth's own
// fallback rules in isolation (no recipe, no block, a disabled block, and the
// `0 !== absent` distinction — this codebase's `Number(null) === 0` trap,
// named in toTurnNumber's docstring, hit a third time by coerceSettingValue
// and a would-be fourth time here if this reused truthiness), and — through
// the real beginDirection pipeline — that the resolved number actually
// governs what reaches the Director, not just what a unit test can observe
// on the resolver alone.
import { test, expect, beforeEach, afterEach } from '@jest/globals';
import {
    initLiveDirection,
    setLiveDirectionTestAdapters,
    submitDirectedRoleplay,
    getLiveDirectionRun,
    stopLiveDirection,
    clearLiveDirectionFailure,
    resolveDirectorSnapshotHistoryDepth,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/live-direction.js';
import { resolveDirectorRecipe, applyPromptBlockSetting } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/prompt-studio.js';
import { buildDirectionSources } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/direction-sources.js';
import { PROMPT_SOURCE_DEFINITIONS } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/prompt-studio-store.js';
import { __setExtensionSettings, __getChat, __emit } from './util/st-context-stub.js';
import { __setOnlineStatus, __clearExtensionPromptCalls } from './util/script-stub.js';
import { __clearDebugEvents } from './util/debug-console-stub.js';

// generateDirectedPerformer touches the DOM once, clearing the composer.
// Jest's environment is `node`; these are the two bindings it reaches for.
globalThis.document ??= { getElementById: () => null };
globalThis.HTMLTextAreaElement ??= class HTMLTextAreaElement {};

const scene = {
    id: 'scene-history-depth',
    timelineId: 'timeline-history-depth',
    title: 'History Depth Scene',
    mode: 'roleplay',
    staging: 'directed',
    liveDirection: { enabled: true, directorRef: null, narratorRef: null, pacing: 'instant', autoplay: false },
};

const cast = [{ ref: { kind: 'character', id: 'char-narrator', label: 'Wren' }, label: 'Wren', characterId: 0 }];

function directorReply() {
    return [
        '[ruling] Nothing mechanical this turn.',
        '```state',
        JSON.stringify({ requests: [], flow: { continue: false } }),
        '```',
    ].join('\n');
}

async function speak() {
    const chat = __getChat();
    chat.push({ name: 'Wren', is_user: false, mes: 'Wren answers.', extra: {} });
    await __emit('MESSAGE_RECEIVED', chat.length - 1);
}

function wire() {
    initLiveDirection({
        getActiveScene: () => scene,
        getCast: () => cast,
        getPersona: () => null,
        ensureSceneReady: async () => true,
        getComposerDraft: () => '',
        clearComposer: () => {},
        sendNormally: () => {},
        onStateChange: () => {},
        onSettled: () => {},
        onFailure: () => {},
    });
}

/** Poll rather than sleep: the reveal loop chains through its own timers. */
async function until(predicate, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) return false;
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return true;
}

/**
 * Seeds `count` prior chat messages, each carrying a token that cannot
 * collide with a neighbour's under plain substring matching — `MARK[1]` is
 * not a substring of `MARK[10]` the way `turn-1` would be of `turn-10`.
 */
function seedHistory(count) {
    const chat = __getChat();
    for (let i = 1; i <= count; i += 1) {
        chat.push({ name: i % 2 === 0 ? 'Wren' : 'User', is_user: i % 2 !== 0, mes: `MARK[${i}]`, extra: {} });
    }
}

/**
 * Captures the snapshot handed to the (stubbed) Director for one submitted
 * action, rendered through the real, pure buildDirectionSources — the same
 * function direction-sources.js's own tests exercise — so an assertion here
 * is about the compiled text the Director actually reads.
 */
async function capturedSnapshotText(actionText) {
    let captured = null;
    setLiveDirectionTestAdapters({
        requestDirection: async ({ snapshot }) => { captured = snapshot; return directorReply(); },
        generatePerformer: speak,
    });
    await submitDirectedRoleplay({ scene, text: actionText });
    await until(() => getLiveDirectionRun()?.state === 'Waiting for you');
    return buildDirectionSources(captured, { mechanicsEnabled: true }).directorSnapshot;
}

beforeEach(() => {
    __setExtensionSettings({});
    __setOnlineStatus('connected');
    __clearExtensionPromptCalls();
    __clearDebugEvents();
    wire();
});

afterEach(async () => {
    await stopLiveDirection();
    clearLiveDirectionFailure();
    setLiveDirectionTestAdapters(null);
});

// ------------------------------------------------------- the source definition

test('directorSnapshot declares a history setting, min 0, max 40, defaulted to 12 — down from the old hardcoded 40', () => {
    const spec = PROMPT_SOURCE_DEFINITIONS.director.find((source) => source.key === 'directorSnapshot')?.settings?.history;
    expect(spec).toBeDefined();
    expect(spec.type).toBe('number');
    expect(spec.min).toBe(0);
    expect(spec.max).toBe(40);
    expect(spec.default).toBe(12);
});

// ----------------------------------- resolveDirectorSnapshotHistoryDepth itself
//
// Exercised directly, with a hand-built `recipe` argument, rather than only
// through the full pipeline below: getPromptStudioStore's own normalizeStore
// self-heals a missing active director recipe on every access (every mode
// always gets one seeded), so "no active director recipe" cannot actually be
// produced by driving the real store through its public API. The function
// still has to survive that case without throwing — this is the only way to
// prove it does.

test('falls back to the declared default when there is no recipe at all', () => {
    expect(resolveDirectorSnapshotHistoryDepth(null)).toBe(12);
});

test('falls back to the declared default when the recipe has no directorSnapshot block', () => {
    const recipe = { blocks: [{ kind: 'source', sourceKey: 'directionProtocol', enabled: true, settings: {} }] };
    expect(resolveDirectorSnapshotHistoryDepth(recipe)).toBe(12);
});

test('falls back to the declared default when the directorSnapshot block is disabled', () => {
    const recipe = { blocks: [{ kind: 'source', sourceKey: 'directorSnapshot', enabled: false, settings: { history: 5 } }] };
    expect(resolveDirectorSnapshotHistoryDepth(recipe)).toBe(12);
});

test('an explicit depth of 0 is returned as 0, not read as absent and defaulted', () => {
    const recipe = { blocks: [{ kind: 'source', sourceKey: 'directorSnapshot', enabled: true, settings: { history: 0 } }] };
    expect(resolveDirectorSnapshotHistoryDepth(recipe)).toBe(0);
});

test('returns the block\'s own value when the block is present, enabled, and set', () => {
    const recipe = { blocks: [{ kind: 'source', sourceKey: 'directorSnapshot', enabled: true, settings: { history: 7 } }] };
    expect(resolveDirectorSnapshotHistoryDepth(recipe)).toBe(7);
});

// ------------------------------------------------------ wired through a real pass
//
// The point of the wrinkle: buildDirectionSnapshot resolves this ahead of the
// compile, so the number has to reach the Director's actual prompt, not just
// a value some unit test can read off the resolver in isolation.

test('with the seeded recipe (default 12), only the 12 most recent messages reach the Director out of 15', async () => {
    seedHistory(15);
    const text = await capturedSnapshotText('I step forward.');
    // The three oldest fall outside the default window...
    expect(text).not.toContain('MARK[1]');
    expect(text).not.toContain('MARK[2]');
    expect(text).not.toContain('MARK[3]');
    // ...and the twelve most recent are still there. With only 15 messages
    // total, a hardcoded slice(-40) would have kept every one of them — this
    // is what tells the two implementations apart.
    for (let i = 4; i <= 15; i += 1) {
        expect(text).toContain(`MARK[${i}]`);
    }
});

test('a custom depth set on the active recipe governs the slice', async () => {
    const recipe = resolveDirectorRecipe();
    const block = recipe.blocks.find((entry) => entry.sourceKey === 'directorSnapshot');
    expect(applyPromptBlockSetting(recipe.id, block.id, 'history', '2').settings.history).toBe(2);

    seedHistory(5);
    const text = await capturedSnapshotText('I step forward.');
    expect(text).not.toContain('MARK[1]');
    expect(text).not.toContain('MARK[2]');
    expect(text).not.toContain('MARK[3]');
    expect(text).toContain('MARK[4]');
    expect(text).toContain('MARK[5]');
});

test('a depth of 0 set on the active recipe reaches the Director as zero messages, not the default 12', async () => {
    const recipe = resolveDirectorRecipe();
    const block = recipe.blocks.find((entry) => entry.sourceKey === 'directorSnapshot');
    expect(applyPromptBlockSetting(recipe.id, block.id, 'history', '0').settings.history).toBe(0);

    seedHistory(5);
    const text = await capturedSnapshotText('I step forward.');
    for (let i = 1; i <= 5; i += 1) {
        expect(text).not.toContain(`MARK[${i}]`);
    }
    // No history at all means the STORY SO FAR section itself is absent, not
    // present-and-empty (direction-sources.js's `section()`: a heading with
    // nothing under it tells the Director less than no heading).
    expect(text).not.toContain('STORY SO FAR');
    // The current action is a separate section from acceptedHistory and is
    // unaffected by the history window collapsing to zero.
    expect(text).toContain('I step forward.');
});
