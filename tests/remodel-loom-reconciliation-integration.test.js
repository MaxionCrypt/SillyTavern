// The Loom reconciliation pass: over a Narrator draft, it commits patched prose
// and records the reply. Goals/Variables are dissolved — the streaming pass no
// longer executes a mechanics `requests` array; lore edits land on the commit
// path, and swaps are the only draft mutation this pass performs.
import { test, expect, beforeEach, afterEach } from '@jest/globals';
import {
    initLiveDirection, setLiveDirectionTestAdapters, runLoomReconciliation, __buildLoomSnapshot,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/live-direction.js';
import { __setExtensionSettings } from './util/st-context-stub.js';
import { __clearDebugEvents, __getDebugEvents } from './util/debug-console-stub.js';

const scene = { id: 'sc-ed', timelineId: 'tl-ed' };

beforeEach(() => {
    __clearDebugEvents();
    __setExtensionSettings({});
    initLiveDirection({
        getActiveScene: () => scene, getCast: () => [], getPersona: () => null,
        ensureSceneReady: async () => true, getComposerDraft: () => '', clearComposer: () => {},
        sendNormally: () => {}, onStateChange: () => {}, onSettled: () => {}, onFailure: () => {},
        setNativePromptContent: () => {},
    });
});
afterEach(() => setLiveDirectionTestAdapters(null));

test('runLoomReconciliation applies the swap to the draft and records the reply', async () => {
    const fence = JSON.stringify({
        swaps: [{ find: 'Marissa melts into him', replace: 'Marissa turns her cheek' }],
        loreKeywords: [],
        loreOps: [],
        flow: { continue: false },
    });
    setLiveDirectionTestAdapters({
        loomReconciliation: async () => ['```state', fence, '```'].join('\n'),
    });
    const snapshot = await __buildLoomSnapshot(scene);
    const { committedProse } = await runLoomReconciliation({
        scene, snapshot,
        draft: 'Eli leans in and Marissa melts into him.',
        draftReasoning: 'goes for the kiss',
    });
    // Preserve-and-patch: the draft is kept; only the swapped span changes.
    expect(committedProse).toBe('Eli leans in and Marissa turns her cheek.');
    const response = __getDebugEvents().find((entry) => entry.category === 'response');
    expect(response.type).toBe('api.response.loom');
    expect(response.detail.text).toContain(fence);
});

test('with final prose and no fence, runLoomReconciliation keeps the Loom version and records nothing', async () => {
    // The model leaks prose but no fence — it is ignored; the draft is canonical.
    setLiveDirectionTestAdapters({ loomReconciliation: async () => 'Eli leans in and she meets him halfway.' });
    const snapshot = await __buildLoomSnapshot(scene);
    const { committedProse, result } = await runLoomReconciliation({ scene, snapshot, draft: 'the draft stands' });
    expect(committedProse).toBe('Eli leans in and she meets him halfway.');
    expect(result).toBe(null);
});
