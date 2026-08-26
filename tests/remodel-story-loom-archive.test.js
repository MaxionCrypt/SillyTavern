import { afterEach, beforeEach, expect, test } from '@jest/globals';
import { listEvents, listSceneFacts } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/archivist-store.js';
import { listArchiveSceneDescriptors } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/archive-scene-list.js';
import { listLivingLoreProposals } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/living-lore-mutations.js';
import { getTimelineGoals } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/story-goals-store.js';
import { listVariableValues } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/variables-store.js';
import {
    buildStoryArchivePrompt,
    captureStoryArchiveCatchUp,
    processStoryArchiveCapture,
    setStoryLoomArchiveTestAdapter,
    supersedeStoryBeatArchive,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/story-loom-archive.js';
import {
    createStoryArchiveCapture,
    createStoryDoc,
    getStoryArchiveCapture,
    listStoryArchiveCaptures,
    previewStoryArchiveCatchUp,
    updateStoryDoc,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/story-doc.js';
import { __setContextOverrides, __setExtensionSettings } from './util/st-context-stub.js';
import { __clearDebugEvents, __getDebugEvents } from './util/debug-console-stub.js';

const scene = {
    id: 'story-scene', timelineId: 'timeline-one', mode: 'story',
    generationProfileIds: { narrator: null, loom: 'loom-profile' },
};

function fence(requests, loreProposals = []) {
    return `\`\`\`state\n${JSON.stringify({ requests, loreProposals, flow: { continue: false } })}\n\`\`\``;
}

function makeCapture() {
    const doc = createStoryDoc({ title: 'Story bridge' });
    updateStoryDoc(doc.id, { body: 'Mara locked the observatory door.' });
    const capture = createStoryArchiveCapture(doc.id, {
        text: 'Mara locked the observatory door.', start: 0, end: 33, generationId: 'story-generation-1',
    });
    return { doc, capture };
}

beforeEach(() => {
    __clearDebugEvents();
    __setExtensionSettings({ remodel: {} });
});
afterEach(() => setStoryLoomArchiveTestAdapter(null));

test('Story and Roleplay Scenes appear in the same Timeline Archive list', () => {
    const timeline = { arcIds: ['arc-1'] };
    const store = {
        arcs: { 'arc-1': { id: 'arc-1', title: 'Opening', sceneIds: ['rp', 'story'] } },
        scenes: {
            rp: { id: 'rp', title: 'Roleplay', mode: 'roleplay' },
            story: { id: 'story', title: 'Manuscript', mode: 'story' },
        },
    };
    expect(listArchiveSceneDescriptors(timeline, store).map((item) => [item.id, item.mode]))
        .toEqual([['rp', 'roleplay'], ['story', 'story']]);
});

test('the Story Loom prompt makes accepted prose immutable and advertises the safe Timeline Web operations', () => {
    const prompt = buildStoryArchivePrompt({
        passage: 'Mara locked the door.',
        archiveState: 'location: observatory',
        recipe: { blocks: [], mode: 'loom', apiType: 'chat' },
    });
    const text = prompt.map((message) => message.content).join('\n');
    expect(text).toContain('manuscript is immutable');
    expect(text).toContain('event.record');
    expect(text).not.toContain('goal.reach');
    expect(text).toContain('Mara locked the door.');
});

test('accepted Story prose applies enabled retrospective requests once', async () => {
    const { doc, capture } = makeCapture();
    setStoryLoomArchiveTestAdapter(async ({ prompt }) => {
        expect(prompt.map((message) => message.content).join('\n')).toContain('Mara locked the observatory door.');
        return fence([
            { id: 'event', capability: 'event.record', arguments: { summary: 'Mara locked the observatory door' }, reason: 'accepted Story prose' },
            { id: 'scene', capability: 'scene.set', arguments: { key: 'observatory door', value: 'locked' }, reason: 'accepted Story prose' },
            { id: 'ignored', capability: 'goal.reach', arguments: { goalRef: 'Break in' }, reason: 'retrospective rolls are disabled' },
        ]);
    });

    const applied = await processStoryArchiveCapture({ scene, docId: doc.id, captureId: capture.id });
    expect(applied.status).toBe('applied');
    expect(applied.transactionId).toBeTruthy();
    expect(listEvents(scene.timelineId, scene.id).map((item) => item.summary)).toEqual(['Mara locked the observatory door']);
    expect(listSceneFacts(scene.timelineId, scene.id)[0]).toMatchObject({ key: 'observatory door', value: 'locked' });

    await processStoryArchiveCapture({ scene, docId: doc.id, captureId: capture.id });
    expect(listEvents(scene.timelineId, scene.id)).toHaveLength(1);
});

test('accepted Story evidence can queue a typed Living Lore proposal alongside the Timeline Web', async () => {
    __setExtensionSettings({ remodel: {
        timelineV1: {
            version: 1,
            timelineIds: [scene.timelineId],
            activeTimelineId: scene.timelineId,
            timelines: { [scene.timelineId]: { id: scene.timelineId, lorebookName: 'Living Story', arcIds: ['arc'] } },
            arcs: { arc: { id: 'arc', timelineId: scene.timelineId, sceneIds: [scene.id] } },
            scenes: { [scene.id]: { ...scene, arcId: 'arc' } },
        },
        worldSenseV1: { version: 2, profile: { mode: 'suggest', maxEntries: 12, maxTokens: 1800 }, indexes: {}, receipts: [], continuityByScene: {} },
    } });
    __setContextOverrides({
        loadWorldInfo: async () => ({ entries: {
            7: { uid: 7, comment: 'Mara', key: ['Mara', 'observatory'], keysecondary: [], content: 'Identity\nMara is the observatory keeper.', disable: false },
        } }),
    });
    const { doc, capture } = makeCapture();
    const proposal = {
        id: 'story-lore-1',
        operation: 'fact.append',
        target: { book: 'Living Story', uid: '7', revision: 1 },
        entryType: 'entity',
        section: 'Established',
        value: 'Mara locked the observatory door.',
        evidence: 'Mara locked the observatory door.',
        confidence: 0.96,
        reason: 'The accepted Story passage establishes a durable action.',
    };
    setStoryLoomArchiveTestAdapter(async ({ prompt }) => {
        const text = prompt.map((message) => message.content).join('\n');
        expect(text).toContain('Selected Living Lore');
        expect(text).toContain('Living Story');
        expect(text).not.toContain('goal.reach');
        return fence([{ id: 'event', capability: 'event.record', arguments: { summary: 'Mara locked the observatory door.' }, reason: 'accepted passage' }], proposal ? [proposal] : []);
    });

    const applied = await processStoryArchiveCapture({ scene, docId: doc.id, captureId: capture.id });
    expect(applied).toMatchObject({ status: 'applied', loreProposalIds: ['story-lore-1'] });
    expect(applied.worldSenseReceiptId).toBeTruthy();
    expect(listLivingLoreProposals({ timelineId: scene.timelineId })).toEqual([
        expect.objectContaining({ id: 'story-lore-1', status: 'suggested', source: expect.objectContaining({ mode: 'story', captureId: capture.id }) }),
    ]);
});

test('regenerating Story evidence invalidates its unapplied Living Lore suggestions', async () => {
    __setExtensionSettings({ remodel: {
        timelineV1: {
            version: 1,
            timelineIds: [scene.timelineId],
            activeTimelineId: scene.timelineId,
            timelines: { [scene.timelineId]: { id: scene.timelineId, lorebookName: 'Living Story', arcIds: ['arc'] } },
            arcs: { arc: { id: 'arc', timelineId: scene.timelineId, sceneIds: [scene.id] } },
            scenes: { [scene.id]: { ...scene, arcId: 'arc' } },
        },
        worldSenseV1: { version: 2, profile: { mode: 'suggest', maxEntries: 12, maxTokens: 1800 }, indexes: {}, receipts: [], continuityByScene: {} },
    } });
    __setContextOverrides({
        loadWorldInfo: async () => ({ entries: {
            7: { uid: 7, comment: 'Mara', key: ['Mara', 'observatory'], keysecondary: [], content: 'Identity\nMara is the observatory keeper.', disable: false },
        } }),
    });
    const doc = createStoryDoc({ title: 'Regenerated lore evidence' });
    updateStoryDoc(doc.id, { body: 'Mara locked the observatory door.' });
    const capture = createStoryArchiveCapture(doc.id, {
        text: 'Mara locked the observatory door.', start: 0, end: 33, generationId: 'story-generation-lore', beatId: 'beat-lore',
    });
    setStoryLoomArchiveTestAdapter(async () => fence([], [{
        id: 'superseded-story-lore',
        operation: 'fact.append',
        target: { book: 'Living Story', uid: '7', revision: 1 },
        entryType: 'entity',
        section: 'Established',
        value: 'Mara locked the observatory door.',
        evidence: 'Mara locked the observatory door.',
        confidence: 0.96,
        reason: 'The accepted Story passage establishes it.',
    }]));

    await processStoryArchiveCapture({ scene, docId: doc.id, captureId: capture.id });
    expect(listLivingLoreProposals({ timelineId: scene.timelineId })[0]?.status).toBe('suggested');
    await supersedeStoryBeatArchive({ scene, docId: doc.id, beatId: 'beat-lore' });
    expect(listLivingLoreProposals({ timelineId: scene.timelineId })[0]).toMatchObject({
        status: 'invalidated', invalidationReason: 'story-generation-superseded',
    });
});

test('accepted Story consequences create linked Timeline Web records without a retrospective roll', async () => {
    __setExtensionSettings({ remodel: {
        timelineV1: {
            version: 1, timelineIds: [scene.timelineId], activeTimelineId: scene.timelineId,
            timelines: { [scene.timelineId]: { id: scene.timelineId, lorebookName: 'Living Story', arcIds: ['arc'] } },
            arcs: { arc: { id: 'arc', timelineId: scene.timelineId, sceneIds: [scene.id] } },
            scenes: { [scene.id]: { ...scene, arcId: 'arc' } },
        },
        worldSenseV1: { version: 2, profile: { mode: 'suggest', maxEntries: 12, maxTokens: 1800 }, indexes: {}, receipts: [], continuityByScene: {} },
    } });
    __setContextOverrides({ loadWorldInfo: async () => ({ entries: {
        7: { uid: 7, comment: 'Mara', key: ['Mara', 'hunt'], keysecondary: [], content: 'Identity\nMara leads the observatory watch.', disable: false },
    } }) });
    const doc = createStoryDoc({ title: 'Consequences' });
    const prose = 'Mara swore to catch the intruder, while the watch lost confidence.';
    updateStoryDoc(doc.id, { body: prose });
    const capture = createStoryArchiveCapture(doc.id, { text: prose, start: 0, end: prose.length, generationId: 'web-1', beatId: 'web-beat' });
    setStoryLoomArchiveTestAdapter(async () => fence([
        { id: 'g', capability: 'goal.create', arguments: { alias: 'hunt', title: 'Mara catches the intruder', description: 'Mara must identify and corner the intruder before they escape.', holderRefs: [{ kind: 'character', id: 'Mara', label: 'Mara' }], successRate: 45 }, reason: 'Mara explicitly commits to the hunt.' },
        { id: 'gl', capability: 'goal.lore.attach', arguments: { goalRef: '$hunt', loreBook: 'Living Story', loreUid: '7', loreRevision: 1, loreType: 'stake' }, reason: 'The hunt belongs to Mara.' },
        { id: 'v', capability: 'variable.create', arguments: { alias: 'confidence', name: 'Watch Confidence', valueType: 'number', value: 35, minimum: 0, maximum: 100, description: 'How strongly the observatory watch trusts its ability to protect the site.' }, reason: 'The accepted passage establishes a loss of confidence.' },
        { id: 'vl', capability: 'variable.lore.attach', arguments: { variableRef: '$confidence', loreBook: 'Living Story', loreUid: '7', loreRevision: 1, loreHint: 'subject' }, reason: 'The confidence belongs to Mara and her watch.' },
        { id: 'roll', capability: 'goal.reach', arguments: { goalRef: '$hunt' }, reason: 'must never execute retrospectively' },
    ]));

    const applied = await processStoryArchiveCapture({ scene, docId: doc.id, captureId: capture.id });
    expect(applied.status).toBe('applied');
    expect(applied.webReceipt).toMatchObject({ captureId: capture.id, transactionId: applied.transactionId });
    expect(applied.webReceipt.mechanics.map((item) => item.capability)).not.toContain('goal.reach');
    expect(applied.loreProposalRejections).toContainEqual(expect.objectContaining({ code: 'story-capability-disabled', capability: 'goal.reach' }));
    expect(getTimelineGoals(scene.timelineId)).toEqual([
        expect.objectContaining({ title: 'Mara catches the intruder', status: 'active', loreLinks: [expect.objectContaining({ book: 'Living Story', uid: '7', type: 'stake' })] }),
    ]);
    expect(listVariableValues({ timelineId: scene.timelineId })).toEqual([
        expect.objectContaining({ name: 'Watch Confidence', value: 35, loreLinks: [expect.objectContaining({ book: 'Living Story', uid: '7', hint: 'subject' })] }),
    ]);
    expect(__getDebugEvents()).toEqual(expect.arrayContaining([
        expect.objectContaining({
            category: 'story-archive', type: 'capture.applied',
            detail: expect.objectContaining({
                sceneMode: 'story', bodyRevision: 1, worldSenseReceiptId: expect.any(String),
                webReceipt: expect.objectContaining({ sourceSceneId: scene.id, documentRevision: 1, sourceSpan: { start: 0, end: prose.length } }),
                loreOutcome: expect.objectContaining({ proposed: 0, queued: 0 }),
            }),
        }),
    ]));

    await supersedeStoryBeatArchive({ scene, docId: doc.id, beatId: 'web-beat' });
    expect(getTimelineGoals(scene.timelineId)).toEqual([]);
    expect(listVariableValues({ timelineId: scene.timelineId })).toEqual([]);
});

test('a valid empty Story Loom fence completes as an idempotent no-op', async () => {
    const { doc, capture } = makeCapture();
    setStoryLoomArchiveTestAdapter(async () => fence([]));
    const applied = await processStoryArchiveCapture({ scene, docId: doc.id, captureId: capture.id });
    expect(applied).toMatchObject({ status: 'applied', transactionId: null, error: '' });
    expect(getStoryArchiveCapture(doc.id, capture.id)?.attempts).toBe(1);
    expect(listEvents(scene.timelineId, scene.id)).toEqual([]);
});

test('an unusable Story Loom response remains visibly retryable', async () => {
    const { doc, capture } = makeCapture();
    setStoryLoomArchiveTestAdapter(async () => 'I would rather continue the story.');
    const failed = await processStoryArchiveCapture({ scene, docId: doc.id, captureId: capture.id });
    expect(failed.status).toBe('failed');
    expect(failed.error).toContain('no readable state fence');
    expect(getStoryArchiveCapture(doc.id, capture.id)?.attempts).toBe(1);
});

test('a failed capture retries on reopen and accepts the bounded quoted-object repair', async () => {
    const { doc, capture } = makeCapture();
    setStoryLoomArchiveTestAdapter(async () => 'not a state fence');
    await processStoryArchiveCapture({ scene, docId: doc.id, captureId: capture.id });
    expect(getStoryArchiveCapture(doc.id, capture.id)?.status).toBe('failed');

    setStoryLoomArchiveTestAdapter(async () => '```state\n{"requests":[{"id":"event","capability":"event.record","arguments":{"summary":"Mara locked the door"},"reason":"accepted passage"},"{"id":"beat","capability":"beat.set","arguments":{"directive":"Someone tests the lock"},"reason":"unresolved beat"}],"flow":{"continue":false}}\n```');
    const retryPreview = previewStoryArchiveCatchUp(doc.id);
    expect(retryPreview).toMatchObject({ changes: [], counts: { retries: 1 } });
    const retry = captureStoryArchiveCatchUp({ scene, docId: doc.id, previewToken: retryPreview.token });
    await retry.completion;

    expect(getStoryArchiveCapture(doc.id, capture.id)).toMatchObject({ status: 'applied', attempts: 2 });
    expect(listEvents(scene.timelineId, scene.id).map((item) => item.summary)).toEqual(['Mara locked the door']);
});

test('regenerating a beat rolls its prior accepted Archive transaction back', async () => {
    const doc = createStoryDoc({ title: 'Regeneration' });
    updateStoryDoc(doc.id, { body: 'The old outcome.' });
    const capture = createStoryArchiveCapture(doc.id, {
        text: 'The old outcome.', start: 0, end: 16, generationId: 'old-generation', beatId: 'beat-one',
    });
    setStoryLoomArchiveTestAdapter(async () => fence([{
        id: 'old-event', capability: 'event.record', arguments: { summary: 'The old outcome happened' }, reason: 'old accepted beat',
    }]));
    await processStoryArchiveCapture({ scene, docId: doc.id, captureId: capture.id });
    expect(listEvents(scene.timelineId, scene.id)).toHaveLength(1);

    await supersedeStoryBeatArchive({ scene, docId: doc.id, beatId: 'beat-one' });
    expect(getStoryArchiveCapture(doc.id, capture.id)).toMatchObject({ status: 'superseded', transactionId: null });
    expect(listEvents(scene.timelineId, scene.id)).toEqual([]);
});

test('a migrated pre-provenance StoryDoc can catch up and roll its new transaction back', async () => {
    __setExtensionSettings({ remodel: { storyDocsV1: {
        version: 1, docIds: ['legacy'], docs: {
            legacy: { id: 'legacy', title: 'Legacy', body: 'Mara opened the old gate.', guidance: '', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
        },
    } } });
    const preview = previewStoryArchiveCatchUp('legacy');
    const capture = createStoryArchiveCapture('legacy', {
        origin: 'user', text: preview.changes[0].afterText, start: 0, end: preview.changes[0].end,
        beatId: 'legacy-catch-up', stableKey: 'legacy-catch-up',
    });
    setStoryLoomArchiveTestAdapter(async () => fence([
        { id: 'event', capability: 'event.record', arguments: { summary: 'Mara opened the old gate.' }, reason: 'accepted legacy prose' },
    ]));

    const applied = await processStoryArchiveCapture({ scene, docId: 'legacy', captureId: capture.id });
    expect(applied.status).toBe('applied');
    expect(listEvents(scene.timelineId, scene.id)).toHaveLength(1);
    await supersedeStoryBeatArchive({ scene, docId: 'legacy', beatId: 'legacy-catch-up' });
    expect(listEvents(scene.timelineId, scene.id)).toEqual([]);
});

test('manual catch-up supersedes edited provenance, preserves audit events, and is repeat-safe', async () => {
    const doc = createStoryDoc({ title: 'Owner edit' });
    updateStoryDoc(doc.id, { body: 'The observatory door was open.' });
    const original = createStoryArchiveCapture(doc.id, {
        text: 'The observatory door was open.', start: 0, end: 30, generationId: 'original',
    });
    setStoryLoomArchiveTestAdapter(async () => fence([{
        id: 'old-event', capability: 'event.record', arguments: { summary: 'The observatory door was open' }, reason: 'accepted passage',
    }]));
    await processStoryArchiveCapture({ scene, docId: doc.id, captureId: original.id });

    updateStoryDoc(doc.id, { body: 'The observatory door was locked.' });
    const preview = previewStoryArchiveCatchUp(doc.id);
    expect(preview.changes[0]).toMatchObject({ type: 'edit', beforeText: 'The observatory door was open.', afterText: 'The observatory door was locked.' });
    setStoryLoomArchiveTestAdapter(async ({ prompt }) => {
        const text = prompt.map((message) => message.content).join('\n');
        expect(text).toContain('BEFORE:\nThe observatory door was open.');
        expect(text).toContain('AFTER:\nThe observatory door was locked.');
        return fence([{
            id: 'new-fact', capability: 'scene.set', arguments: { key: 'observatory door', value: 'locked' }, reason: 'author edit',
        }]);
    });
    const submitted = captureStoryArchiveCatchUp({ scene, docId: doc.id, previewToken: preview.token });
    expect(submitted).toMatchObject({ ok: true, stale: false });
    await submitted.completion;

    expect(getStoryArchiveCapture(doc.id, original.id)).toMatchObject({
        status: 'superseded', supersededBy: submitted.captures[0].id,
    });
    expect(listEvents(scene.timelineId, scene.id).map((item) => item.summary)).toEqual(['The observatory door was open']);
    expect(previewStoryArchiveCatchUp(doc.id).changes).toEqual([]);
    expect(listStoryArchiveCaptures(doc.id).filter((capture) => capture.status !== 'superseded')).toHaveLength(1);
});

test('manual catch-up refuses a preview made stale by concurrent autosave', () => {
    const doc = createStoryDoc({ title: 'Stale preview' });
    updateStoryDoc(doc.id, { body: 'First version.' });
    const preview = previewStoryArchiveCatchUp(doc.id);
    updateStoryDoc(doc.id, { body: 'Second version.' });
    const submitted = captureStoryArchiveCatchUp({ scene, docId: doc.id, previewToken: preview.token });
    expect(submitted).toMatchObject({ ok: false, stale: true, captures: [] });
});

test('manual deletion reaches the Loom as before/deleted evidence and clears mutable Archive state', async () => {
    const doc = createStoryDoc({ title: 'Owner deletion' });
    updateStoryDoc(doc.id, { body: 'A silver key rests on the desk.' });
    const original = createStoryArchiveCapture(doc.id, {
        text: 'A silver key rests on the desk.', start: 0, end: 31, generationId: 'key-source',
    });
    setStoryLoomArchiveTestAdapter(async () => fence([{
        id: 'key-fact', capability: 'scene.set', arguments: { key: 'silver key', value: 'on the desk' }, reason: 'accepted passage',
    }]));
    await processStoryArchiveCapture({ scene, docId: doc.id, captureId: original.id });
    updateStoryDoc(doc.id, { body: '' });
    const preview = previewStoryArchiveCatchUp(doc.id);
    expect(preview.changes[0].type).toBe('deletion');

    setStoryLoomArchiveTestAdapter(async ({ prompt }) => {
        expect(prompt.map((message) => message.content).join('\n')).toContain('AFTER:\n[deleted]');
        return fence([{
            id: 'clear-key', capability: 'scene.clear', arguments: { key: 'silver key' }, reason: 'author deleted the assertion',
        }]);
    });
    const submitted = captureStoryArchiveCatchUp({ scene, docId: doc.id, previewToken: preview.token });
    await submitted.completion;
    expect(getStoryArchiveCapture(doc.id, submitted.captures[0].id)).toMatchObject({ changeType: 'deletion', text: '', beforeText: 'A silver key rests on the desk.', status: 'applied' });
    expect(listSceneFacts(scene.timelineId, scene.id)).toEqual([]);
});

test('an oversized failed legacy catch-up resumes as bounded sequential passages', async () => {
    const body = Array.from({ length: 900 }, (_value, index) => `Paragraph ${index + 1} establishes one small fact.`).join('\n\n');
    const doc = createStoryDoc({ title: 'Large legacy story' });
    updateStoryDoc(doc.id, { body });
    const oversized = createStoryArchiveCapture(doc.id, {
        origin: 'user', text: body, start: 0, end: body.length, stableKey: 'legacy-whole-story',
    });
    setStoryLoomArchiveTestAdapter(async () => 'no state fence');
    await processStoryArchiveCapture({ scene, docId: doc.id, captureId: oversized.id });
    expect(getStoryArchiveCapture(doc.id, oversized.id)?.status).toBe('failed');

    let calls = 0;
    setStoryLoomArchiveTestAdapter(async ({ prompt }) => {
        calls += 1;
        const evidence = prompt.map((message) => message.content).join('\n');
        expect(evidence.length).toBeLessThan(body.length);
        return fence([]);
    });
    const retryPreview = previewStoryArchiveCatchUp(doc.id);
    expect(retryPreview).toMatchObject({ changes: [], counts: { retries: 1 } });
    const retry = captureStoryArchiveCatchUp({ scene, docId: doc.id, previewToken: retryPreview.token });
    await retry.completion;
    const captures = listStoryArchiveCaptures(doc.id);
    const parts = captures.filter((capture) => capture.supersedesCaptureIds.includes(oversized.id));
    expect(getStoryArchiveCapture(doc.id, oversized.id)?.status).toBe('superseded');
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((capture) => capture.status === 'applied' && capture.text.length <= 6000)).toBe(true);
    expect(calls).toBe(parts.length);
    expect(previewStoryArchiveCatchUp(doc.id).changes).toEqual([]);
});
