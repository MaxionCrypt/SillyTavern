// The Loom reconciliation pass: over a Narrator draft, it commits patched prose
// and records the state (events + mechanics), resolving refs against the run's
// address book. Dice are code-rolled by the mechanics layer (not here).
import { test, expect, beforeEach, afterEach } from '@jest/globals';
import {
    initLiveDirection, setLiveDirectionTestAdapters, runLoomReconciliation, __buildLoomSnapshot,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/live-direction.js';
import { listEvents } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/archivist-store.js';
import { createVariableValue, getVariableValue, updateMechanicsProfile } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/variables-store.js';
import { __setExtensionSettings } from './util/st-context-stub.js';
import { __clearDebugEvents, __getDebugEvents } from './util/debug-console-stub.js';
import { buildLivingLorePacket } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/living-lore-proposals.js';

const scene = { id: 'sc-ed', timelineId: 'tl-ed' };
let trustId = '';

beforeEach(() => {
    __clearDebugEvents();
    __setExtensionSettings({});
    updateMechanicsProfile({ enabled: true });
    trustId = createVariableValue({
        timelineId: 'tl-ed', name: "Marissa's Trust", valueType: 'number', value: 20,
        description: 'how much she trusts Eli', authority: 'world', retrieval: { mode: 'always' },
    }).id;
    initLiveDirection({
        getActiveScene: () => scene, getCast: () => [], getPersona: () => null,
        ensureSceneReady: async () => true, getComposerDraft: () => '', clearComposer: () => {},
        sendNormally: () => {}, onStateChange: () => {}, onSettled: () => {}, onFailure: () => {},
        setNativePromptContent: () => {},
    });
});
afterEach(() => setLiveDirectionTestAdapters(null));

test('runLoomReconciliation applies the swap to the draft and records the state', async () => {
    const fence = JSON.stringify({
        swaps: [{ find: 'Marissa melts into him', replace: 'Marissa turns her cheek' }],
        requests: [
            { id: 'r1', capability: 'event.record', arguments: { summary: 'Eli tried to kiss Marissa; she pulled back' }, reason: 'roll failed' },
            { id: 'r2', capability: 'variable.adjust', arguments: { variableRef: "Marissa's Trust", delta: -2 }, reason: 'he overstepped' },
        ],
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
    // The state fence was recorded to the archivist…
    expect(listEvents(scene.timelineId, scene.id).map((e) => e.summary)).toEqual(['Eli tried to kiss Marissa; she pulled back']);
    // …and the mechanics resolved against the address book — Trust 20 → 18.
    expect(Number(getVariableValue(trustId, 'tl-ed')?.value)).toBe(18);
    const response = __getDebugEvents().find((entry) => entry.category === 'response');
    expect(response.type).toBe('api.response.loom');
    expect(response.detail.text).toContain(fence);
});

test('with final prose and no requests, runLoomReconciliation keeps the Loom version and records nothing', async () => {
    // The model leaks prose but no fence — it is ignored; the draft is canonical.
    setLiveDirectionTestAdapters({ loomReconciliation: async () => 'Eli leans in and she meets him halfway.' });
    const snapshot = await __buildLoomSnapshot(scene);
    const { committedProse, result } = await runLoomReconciliation({ scene, snapshot, draft: 'the draft stands' });
    expect(committedProse).toBe('Eli leans in and she meets him halfway.');
    expect(result).toBe(null);
    expect(listEvents(scene.timelineId, scene.id)).toEqual([]);
});

test('Archive operations remain available when optional Goals and Variables mechanics are disabled', async () => {
    updateMechanicsProfile({ enabled: false });
    let sentPrompt = '';
    setLiveDirectionTestAdapters({
        loomReconciliation: async ({ prompt }) => {
            sentPrompt = prompt.map((message) => message.content).join('\n');
            return 'The draft stands.\n```state\n{"requests":[],"flow":{"continue":false}}\n```';
        },
    });
    const snapshot = await __buildLoomSnapshot(scene);
    await runLoomReconciliation({ scene, snapshot, draft: 'The draft stands.' });

    expect(sentPrompt).toContain('[ARCHIVE OPERATIONS — always available]');
    expect(sentPrompt).toContain('event.record');
    expect(sentPrompt).toContain('scene.set');
    expect(sentPrompt).toContain('beat.set');
    expect(sentPrompt).not.toContain('Mechanical automation is unavailable this turn');
});

test('the Loom receives selected revisioned lore and returns detached typed proposals only', async () => {
    const livingLore = buildLivingLorePacket({
        timelineId: scene.timelineId,
        book: 'Timeline Book',
        bookHash: 'hash-1',
        entries: [{ book: 'Timeline Book', uid: '42', name: 'Marissa', keys: ['Marissa'], secondaryKeys: [], content: 'Current: Marissa is in the cafe.' }],
        selected: [{ book: 'Timeline Book', uid: '42', reasons: [{ channel: 'action.primary' }] }],
        metadata: [{ book: 'Timeline Book', uid: '42', revision: 7, entryType: 'entity' }],
    });
    const proposal = {
        operation: 'current.set', target: { book: 'Timeline Book', uid: '42', revision: 7 },
        entryType: 'entity', section: 'Current', value: 'Marissa is in the archive.',
        evidence: 'Marissa crossed into the archive.', confidence: 0.9, reason: 'Her current location changed.',
    };
    let sentPrompt = '';
    setLiveDirectionTestAdapters({
        loomReconciliation: async ({ prompt }) => {
            sentPrompt = prompt.map((message) => message.content).join('\n');
            return `The draft stands.\n\`\`\`state\n${JSON.stringify({ requests: [], loreProposals: [proposal], flow: { continue: false } })}\n\`\`\``;
        },
    });
    const snapshot = { ...await __buildLoomSnapshot(scene), livingLore };
    const result = await runLoomReconciliation({ scene, snapshot, draft: 'The draft stands.' });

    expect(sentPrompt).toContain('Selected Living Lore');
    expect(sentPrompt).toContain('"revision": 7');
    expect(sentPrompt).toContain('loreProposals');
    expect(result.loreProposals).toEqual([proposal]);
    expect(result.loreProposalRejections).toEqual([]);
    const diagnostic = __getDebugEvents().find((entry) => entry.type === 'lore.proposals.parsed');
    expect(diagnostic.detail.proposals).toEqual([proposal]);
});
