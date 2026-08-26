import { afterEach, beforeEach, expect, test } from '@jest/globals';
import { listEvents, listSceneFacts } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/archivist-store.js';
import { listArchiveSceneDescriptors } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/archive-scene-list.js';
import {
    buildStoryArchivePrompt,
    processStoryArchiveCapture,
    resumeStoryArchiveCaptures,
    setStoryLoomArchiveTestAdapter,
    supersedeStoryBeatArchive,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/story-loom-archive.js';
import {
    createStoryArchiveCapture,
    createStoryDoc,
    getStoryArchiveCapture,
    updateStoryDoc,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/story-doc.js';
import { __setExtensionSettings } from './util/st-context-stub.js';

const scene = {
    id: 'story-scene', timelineId: 'timeline-one', mode: 'story',
    generationProfileIds: { narrator: null, loom: 'loom-profile' },
};

function fence(requests) {
    return `\`\`\`state\n${JSON.stringify({ requests, loreProposals: [], flow: { continue: false } })}\n\`\`\``;
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
    await resumeStoryArchiveCaptures({ scene, docId: doc.id });

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
