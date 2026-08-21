// The Director-editor pass: over a narrator draft, it commits the patched prose
// and records the state (events + mechanics), resolving refs against the run's
// address book. Dice are code-rolled by the mechanics layer (not here).
import { test, expect, beforeEach, afterEach } from '@jest/globals';
import {
    initLiveDirection, setLiveDirectionTestAdapters, runDirectorEdit, __buildEditorSnapshot,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/live-direction.js';
import { listEvents } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/archivist-store.js';
import { createVariableValue, getVariableValue, updateMechanicsProfile } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/variables-store.js';
import { __setExtensionSettings } from './util/st-context-stub.js';

const scene = { id: 'sc-ed', timelineId: 'tl-ed' };
let trustId = '';

beforeEach(() => {
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

test('runDirectorEdit applies the swap to the draft and records the state', async () => {
    const fence = JSON.stringify({
        swaps: [{ find: 'Marissa melts into him', replace: 'Marissa turns her cheek' }],
        requests: [
            { id: 'r1', capability: 'event.record', arguments: { summary: 'Eli tried to kiss Marissa; she pulled back' }, reason: 'roll failed' },
            { id: 'r2', capability: 'variable.adjust', arguments: { variableRef: "Marissa's Trust", delta: -2 }, reason: 'he overstepped' },
        ],
        flow: { continue: false },
    });
    setLiveDirectionTestAdapters({
        directorEdit: async () => ['```state', fence, '```'].join('\n'),
    });
    const snapshot = await __buildEditorSnapshot(scene);
    const { committedProse } = await runDirectorEdit({
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
});

test('with no swaps and no requests, runDirectorEdit keeps the draft verbatim and records nothing', async () => {
    // The model leaks prose but no fence — it is ignored; the draft is canonical.
    setLiveDirectionTestAdapters({ directorEdit: async () => 'Eli leans in and she meets him halfway.' });
    const snapshot = await __buildEditorSnapshot(scene);
    const { committedProse, result } = await runDirectorEdit({ scene, snapshot, draft: 'the draft stands' });
    expect(committedProse).toBe('the draft stands');
    expect(result).toBe(null);
    expect(listEvents(scene.timelineId, scene.id)).toEqual([]);
});
