import { afterEach, beforeEach, expect, test } from '@jest/globals';
import { listEvents, listSceneFacts } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/archivist-store.js';
import { listArchiveSceneDescriptors } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/archive-scene-list.js';
import { listLivingLoreProposals } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/living-lore-mutations.js';
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

beforeEach(() => __setExtensionSettings({ remodel: {} }));
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

test('the Story Loom prompt makes accepted prose immutable and advertises only Archive operations', () => {
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

test('accepted Story prose applies only Archive requests once', async () => {
    const { doc, capture } = makeCapture();
    setStoryLoomArchiveTestAdapter(async ({ prompt }) => {
        expect(prompt.map((message) => message.content).join('\n')).toContain('Mara locked the observatory door.');
        return fence([
            { id: 'event', capability: 'event.record', arguments: { summary: 'Mara locked the observatory door' }, reason: 'accepted Story prose' },
            { id: 'scene', capability: 'scene.set', arguments: { key: 'observatory door', value: 'locked' }, reason: 'accepted Story prose' },
            { id: 'ignored', capability: 'goal.create', arguments: { title: 'Break in', description: 'Enter the observatory', holderRefs: [] }, reason: 'not enabled in Commit 13' },
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

test('accepted Story evidence can queue a typed Living Lore proposal without enabling Goal or Variable writes', async () => {
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
