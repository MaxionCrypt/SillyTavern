import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';
import { createArchiveJobRepository, createMemoryArchiveJobPersistence } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/archive-job-store.js';
import { createArchiveIngestion } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/archive-ingestion.js';
import { legacyArchiveIngestionAdapter } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/legacy-archive-ingestion-adapter.js';
import { createBackgroundArchiveRuntime, setBackgroundArchiveRuntimeForTests } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/background-archive-runtime.js';
import { listEvents, listSceneFacts, recordEvent, setSceneFact } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/archivist-store.js';
import { listArchiveSceneDescriptors } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/archive-scene-list.js';
import { listLivingLoreProposals, queueLivingLoreProposals } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/living-lore-mutations.js';
import { listLivingLoreWrites, upsertLivingLoreMetadata } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/living-lore-store.js';
import { getTimelineGoals } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/story-goals-store.js';
import { listVariableValues } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/variables-store.js';
import {
    buildStoryArchivePrompt,
    captureStoryArchiveCatchUp,
    describeStoryArchiveCaptureState,
    queueStoryArchiveCapture,
    queueStoryArchiveCaptures,
    processStoryArchiveCapture,
    setStoryLoomArchiveTestAdapter,
    supersedeStoryBeatArchive,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/story-loom-archive.js';
import {
    createStoryArchiveCapture,
    createStoryArchiveCaptures,
    createStoryDoc,
    getStoryArchiveCapture,
    listStoryArchiveCaptures,
    previewStoryArchiveCatchUp,
    updateStoryDoc,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/story-doc.js';
import { countStoryArchiveWords, STORY_ARCHIVE_PASSAGE_MAX_WORDS } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/story-archive-provenance.js';
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
afterEach(() => {
    setStoryLoomArchiveTestAdapter(null);
    setBackgroundArchiveRuntimeForTests(null);
});

test('production Story capture queues the shared background Archive without Goals, Variables, or lore', async () => {
    __setExtensionSettings({ remodel: {}, connectionManager: { profiles: [{ id: 'loom-profile', name: 'Loom', api: 'openrouter', model: 'test/archive-model' }] } });
    const commit = jest.fn(async ({ operations }) => ({ transactionId: 'archive-only', count: operations.length }));
    const runtime = createBackgroundArchiveRuntime({
        repository: createArchiveJobRepository({ persistence: createMemoryArchiveJobPersistence() }),
        transport: async () => fence([
            { id: 'archive', capability: 'event.record', arguments: { summary: 'Mara locked the door.' } },
            { id: 'goal', capability: 'goal.create', arguments: { title: 'Must not run' } },
        ], [{ operation: 'fact.append', value: 'Must not queue' }]),
        ingestion: createArchiveIngestion(legacyArchiveIngestionAdapter),
        commit,
    });
    setBackgroundArchiveRuntimeForTests(runtime);
    const { doc, capture } = makeCapture();
    const applied = await queueStoryArchiveCapture({ scene, docId: doc.id, captureId: capture.id });
    expect(applied.status).toBe('applied');
    expect(commit.mock.calls[0][0].operations).toEqual([expect.objectContaining({ capability: 'event.record' })]);
    expect(applied.loreProposalIds).toEqual([]);
});

test('manual manuscript changes advertise Archive catch-up instead of looking fully saved', () => {
    const doc = createStoryDoc({ title: 'Manual archive signal' });
    updateStoryDoc(doc.id, { body: 'A new off-screen threat entered the story.' });
    expect(describeStoryArchiveCaptureState(doc.id)).toMatchObject({
        status: 'catch-up',
        label: 'Archive catch-up available',
    });
});

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

test('the Story Loom prompt contains only the selected recipe and its placed sources', () => {
    setSceneFact('tl-own', 'sc-own', 'location', 'observatory');
    const prompt = buildStoryArchivePrompt({
        passage: 'Mara locked the door.',
        timelineId: 'tl-own', sceneId: 'sc-own',
        recipe: {
            mode: 'loom', apiType: 'chat',
            blocks: [
                { id: 'policy', kind: 'message', role: 'system', content: 'Accepted manuscript is immutable.', enabled: true },
                { id: 'scene', kind: 'message', role: 'system', content: '{{loom.scene}}', enabled: true },
                { id: 'passage', kind: 'message', role: 'user', content: '{{story.archive_capture}}', enabled: true },
                { id: 'contract', kind: 'message', role: 'system', content: 'Return a single state fence.', enabled: true },
            ],
        },
    });
    const text = prompt.map((message) => message.content).join('\n');
    expect(text).toContain('Accepted manuscript is immutable.');
    expect(text).toContain('- location: observatory');
    expect(text).toContain('Mara locked the door.');
    expect(text).toContain('Return a single state fence.');
    expect(text).not.toContain('You are the Loom reading an accepted Story manuscript passage');
    expect(text).not.toContain('Output NOTHING except one state fence');
});

test('an ordered Story capture batch sends one Loom prompt per block from oldest to newest', async () => {
    const doc = createStoryDoc({ title: 'Ordered automatic capture' });
    const prose = Array.from({ length: 1_025 }, (_unused, index) => `passage${index + 1}`).join(' ');
    updateStoryDoc(doc.id, { body: prose });
    const captures = createStoryArchiveCaptures(doc.id, {
        text: prose, start: 0, end: prose.length, generationId: 'automatic-batch-1', beatId: 'beat-1',
    });
    const sentPassages = [];
    setStoryLoomArchiveTestAdapter(async ({ prompt }) => {
        sentPassages.push(prompt.map((message) => message.content).join('\n'));
        return fence([]);
    });

    const results = await queueStoryArchiveCaptures({ scene, docId: doc.id, captureIds: captures.map((capture) => capture.id) });

    expect(results.map((capture) => capture.status)).toEqual(['applied', 'applied']);
    expect(sentPassages).toHaveLength(2);
    expect(sentPassages[0]).toContain('passage1');
    expect(sentPassages[0]).toContain('passage1000');
    expect(sentPassages[0]).not.toContain('passage1001');
    expect(sentPassages[1]).toContain('passage1001');
    expect(sentPassages[1]).toContain('passage1025');
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

test('accepted Story evidence files Living Lore alongside the Timeline Web', async () => {
    __setExtensionSettings({ remodel: {
        timelineV1: {
            version: 1,
            timelineIds: [scene.timelineId],
            activeTimelineId: scene.timelineId,
            timelines: { [scene.timelineId]: { id: scene.timelineId, lorebookName: 'Living Story', arcIds: ['arc'] } },
            arcs: { arc: { id: 'arc', timelineId: scene.timelineId, sceneIds: [scene.id] } },
            scenes: { [scene.id]: { ...scene, arcId: 'arc' } },
        },
        worldSenseV1: { version: 4, profile: { mode: 'suggest', maxEntries: 12, maxTokens: 1800 }, indexes: {}, receipts: [], continuityByScene: {} },
    } });
    let storyBook = { entries: {
            7: { uid: 7, comment: 'Mara', key: ['Mara', 'observatory'], keysecondary: [], content: 'Identity\nMara is the observatory keeper.', disable: false },
    } };
    __setContextOverrides({
        loadWorldInfo: async () => structuredClone(storyBook),
        saveWorldInfo: async (_name, data) => { storyBook = structuredClone(data); },
    });
    const { doc, capture } = makeCapture();
    // The Loom reports what is now true. It names no entry, operation or
    // revision: placement is worked out from the report.
    const proposal = {
        content: 'Mara locked the observatory door.',
        name: 'The observatory door',
        keys: ['observatory door'],
        evidence: 'Mara locked the observatory door.',
    };
    setStoryLoomArchiveTestAdapter(async ({ prompt }) => {
        const text = prompt.map((message) => message.content).join('\n');
        expect(text).toContain('Selected Living Lore');
        expect(text).toContain('Living Story');
        expect(text).not.toContain('goal.reach');
        return fence([{ id: 'event', capability: 'event.record', arguments: { summary: 'Mara locked the observatory door.' }, reason: 'accepted passage' }], proposal ? [proposal] : []);
    });

    const applied = await processStoryArchiveCapture({ scene, docId: doc.id, captureId: capture.id });
    expect(applied).toMatchObject({ status: 'applied' });
    expect(applied.worldSenseReceiptId).toBeTruthy();
    // The information reached the lorebook itself, not a queue beside it.
    expect(Object.values(storyBook.entries).map((entry) => entry.content).join(' '))
        .toContain('Mara locked the observatory door.');
    // ...and the ledger knows where it went, so a superseded capture can undo it.
    expect(listLivingLoreWrites({ timelineId: scene.timelineId, status: 'written' })).toEqual([
        expect.objectContaining({ directionId: `story-archive:${capture.id}` }),
    ]);
});

test('an ordered elided Story quotation remains valid proposal evidence', async () => {
    const timelineId = 'timeline-elided-evidence';
    __setExtensionSettings({ remodel: { worldSenseV1: { version: 4, profile: { mode: 'suggest' }, indexes: {}, receipts: [], continuityByScene: {} } } });
    __setContextOverrides({
        loadWorldInfo: async () => ({ entries: {
            2: { uid: 2, comment: 'Vesper House', key: ['Vesper House'], content: 'Identity\nA residence hall.', disable: false },
        } }),
    });
    const target = { book: 'Vox Test', uid: '2', revision: 1 };
    upsertLivingLoreMetadata(timelineId, target, { entryType: 'situation', revision: 1 });
    const result = await queueLivingLoreProposals({
        timelineId,
        packet: { book: 'Vox Test', entries: [{ target, entryType: 'situation' }] },
        acceptedProse: "They got the partnership. The alumni deal. They're doing the halftime show at the Founder's game and then the Alumni Gala thing, because some alum who owns a chain of gyms is sponsoring them.",
        proposals: [{
            id: 'elided-story-evidence', operation: 'fact.append', target, entryType: 'situation', section: 'Established',
            value: 'The Gold Squad has an alumni gym-chain sponsorship.',
            evidence: "They got the partnership. The alumni deal. They're doing the halftime show at the Founder's game and then the Alumni Gala thing... because some alum who owns a chain of gyms is sponsoring them.",
            confidence: 0.93, reason: 'The passage establishes a durable campus fact.',
        }],
    });

    expect(result).toMatchObject({ ok: true, queued: [expect.objectContaining({ id: 'elided-story-evidence', evidence: expect.objectContaining({ source: 'accepted-prose-elided' }) })], rejected: [] });
});

test('regenerating Story evidence takes its filed Living Lore back out', async () => {
    __setExtensionSettings({ remodel: {
        timelineV1: {
            version: 1,
            timelineIds: [scene.timelineId],
            activeTimelineId: scene.timelineId,
            timelines: { [scene.timelineId]: { id: scene.timelineId, lorebookName: 'Living Story', arcIds: ['arc'] } },
            arcs: { arc: { id: 'arc', timelineId: scene.timelineId, sceneIds: [scene.id] } },
            scenes: { [scene.id]: { ...scene, arcId: 'arc' } },
        },
        worldSenseV1: { version: 4, profile: { mode: 'suggest', maxEntries: 12, maxTokens: 1800 }, indexes: {}, receipts: [], continuityByScene: {} },
    } });
    let regenBook = { entries: {
            7: { uid: 7, comment: 'Mara', key: ['Mara', 'observatory'], keysecondary: [], content: 'Identity\nMara is the observatory keeper.', disable: false },
    } };
    __setContextOverrides({
        loadWorldInfo: async () => structuredClone(regenBook),
        saveWorldInfo: async (_name, data) => { regenBook = structuredClone(data); },
    });
    const doc = createStoryDoc({ title: 'Regenerated lore evidence' });
    updateStoryDoc(doc.id, { body: 'Mara locked the observatory door.' });
    const capture = createStoryArchiveCapture(doc.id, {
        text: 'Mara locked the observatory door.', start: 0, end: 33, generationId: 'story-generation-lore', beatId: 'beat-lore',
    });
    setStoryLoomArchiveTestAdapter(async () => fence([], [{
        content: 'Mara locked the observatory door.',
        name: 'The observatory door',
        keys: ['observatory door'],
        evidence: 'Mara locked the observatory door.',
    }]));

    await processStoryArchiveCapture({ scene, docId: doc.id, captureId: capture.id });
    // Filed straight into the lorebook, so superseding must remove it again
    // rather than discard an unapplied suggestion.
    expect(Object.values(regenBook.entries).map((entry) => entry.content).join(' '))
        .toContain('Mara locked the observatory door.');
    expect(listLivingLoreWrites({ timelineId: scene.timelineId, status: 'written' })).toHaveLength(1);

    await supersedeStoryBeatArchive({ scene, docId: doc.id, beatId: 'beat-lore' });
    expect(Object.values(regenBook.entries).map((entry) => entry.content).join(' '))
        .not.toContain('Mara locked the observatory door.');
    expect(listLivingLoreWrites({ timelineId: scene.timelineId, status: 'written' })).toHaveLength(0);
});

test('accepted Story consequences create linked Timeline Web records without a retrospective roll', async () => {
    __setExtensionSettings({ remodel: {
        timelineV1: {
            version: 1, timelineIds: [scene.timelineId], activeTimelineId: scene.timelineId,
            timelines: { [scene.timelineId]: { id: scene.timelineId, lorebookName: 'Living Story', arcIds: ['arc'] } },
            arcs: { arc: { id: 'arc', timelineId: scene.timelineId, sceneIds: [scene.id] } },
            scenes: { [scene.id]: { ...scene, arcId: 'arc' } },
        },
        worldSenseV1: { version: 4, profile: { mode: 'suggest', maxEntries: 12, maxTokens: 1800 }, indexes: {}, receipts: [], continuityByScene: {} },
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

test('manual Catch Up closes a short final manuscript block and starts later writing fresh', async () => {
    const words = (prefix, count) => Array.from({ length: count }, (_value, index) => `${prefix}${index + 1}`).join(' ');
    const firstBlock = words('first', 1175);
    const doc = createStoryDoc({ title: 'Closed manual blocks' });
    updateStoryDoc(doc.id, { body: firstBlock });
    setStoryLoomArchiveTestAdapter(async () => fence([]));

    const firstPreview = previewStoryArchiveCatchUp(doc.id);
    const first = captureStoryArchiveCatchUp({ scene, docId: doc.id, previewToken: firstPreview.token });
    expect(first.captures).toHaveLength(2);
    expect(first.captures.map((capture) => countStoryArchiveWords(capture.text))).toEqual([1000, 175]);
    await first.completion;
    expect(first.captures.every((capture) => getStoryArchiveCapture(doc.id, capture.id)?.status === 'applied')).toBe(true);

    const laterBlock = words('later', 25);
    updateStoryDoc(doc.id, { body: `${firstBlock}\n\n${laterBlock}` });
    const laterPreview = previewStoryArchiveCatchUp(doc.id);
    expect(laterPreview.changes).toEqual([expect.objectContaining({ type: 'addition', afterText: laterBlock })]);

    const later = captureStoryArchiveCatchUp({ scene, docId: doc.id, previewToken: laterPreview.token });
    expect(later.captures).toHaveLength(1);
    expect(countStoryArchiveWords(later.captures[0].text)).toBe(25);
    expect(STORY_ARCHIVE_PASSAGE_MAX_WORDS).toBe(1000);
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
    expect(parts.every((capture) => capture.status === 'applied' && countStoryArchiveWords(capture.text) <= STORY_ARCHIVE_PASSAGE_MAX_WORDS)).toBe(true);
    expect(calls).toBe(parts.length);
    expect(previewStoryArchiveCatchUp(doc.id).changes).toEqual([]);
});

// --- Living Lore on the PRODUCTION Story path -------------------------------
//
// The test adapter above filed lore all along. Production ran through the
// background worker, whose Archive port is archive-only, and so a Story scene
// was shown no lore packet and had every loreProposal silently dropped. These
// pin the production path specifically: real runtime, fake transport only.

function storyLoreSettings() {
    __setExtensionSettings({ remodel: {
        timelineV1: {
            version: 1,
            timelineIds: [scene.timelineId],
            activeTimelineId: scene.timelineId,
            timelines: { [scene.timelineId]: { id: scene.timelineId, lorebookName: 'Living Story', arcIds: ['arc'] } },
            arcs: { arc: { id: 'arc', timelineId: scene.timelineId, sceneIds: [scene.id] } },
            scenes: { [scene.id]: { ...scene, arcId: 'arc' } },
        },
        worldSenseV1: { version: 4, profile: { mode: 'suggest', maxEntries: 12, maxTokens: 1800 }, indexes: {}, receipts: [], continuityByScene: {} },
    }, connectionManager: { profiles: [{ id: 'loom-profile', name: 'Loom', api: 'openrouter', model: 'test/archive-model' }] } });
}

test('production Story capture shows the Loom its Living Lore and files what it reports', async () => {
    storyLoreSettings();
    let storyBook = { entries: {
        7: { uid: 7, comment: 'Mara', key: ['Mara', 'observatory'], keysecondary: [], content: 'Identity\nMara is the observatory keeper.', disable: false },
    } };
    __setContextOverrides({
        loadWorldInfo: async () => structuredClone(storyBook),
        saveWorldInfo: async (_name, data) => { storyBook = structuredClone(data); },
    });
    const prompts = [];
    const runtime = createBackgroundArchiveRuntime({
        repository: createArchiveJobRepository({ persistence: createMemoryArchiveJobPersistence() }),
        transport: async ({ promptSnapshot }) => {
            prompts.push(promptSnapshot.messages.map((message) => message.content).join('\n'));
            return fence(
                [{ id: 'event', capability: 'event.record', arguments: { summary: 'Mara locked the observatory door.' }, reason: 'accepted passage' }],
                [{ content: 'Mara locked the observatory door.', name: 'The observatory door', keys: ['observatory door'], evidence: 'Mara locked the observatory door.' }],
            );
        },
        ingestion: createArchiveIngestion(legacyArchiveIngestionAdapter),
        commit: jest.fn(async () => ({ transactionId: 'bg-lore' })),
    });
    setBackgroundArchiveRuntimeForTests(runtime);
    const doc = createStoryDoc({ title: 'Production lore' });
    updateStoryDoc(doc.id, { body: 'Mara locked the observatory door.' });
    const capture = createStoryArchiveCapture(doc.id, {
        text: 'Mara locked the observatory door.', start: 0, end: 33, generationId: 'story-generation-bg', beatId: 'beat-bg',
    });

    const applied = await queueStoryArchiveCapture({ scene, docId: doc.id, captureId: capture.id });
    expect(applied).toMatchObject({ status: 'applied', transactionId: 'bg-lore' });
    // The packet reached the prompt the worker actually sent...
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('Selected Living Lore (what the world already records about this scene):');
    expect(prompts[0]).toContain('"book": "Living Story"');
    // ...the report reached the lorebook itself...
    expect(Object.values(storyBook.entries).map((entry) => entry.content).join(' ')).toContain('Mara locked the observatory door.');
    expect(applied.loreProposalIds).toHaveLength(1);
    expect(applied.worldSenseReceiptId).toBeTruthy();
    // ...and the ledger knows the capture that filed it, so superseding it
    // takes the lore back out through the same path the test adapter uses.
    expect(listLivingLoreWrites({ timelineId: scene.timelineId, status: 'written' })).toEqual([
        expect.objectContaining({ directionId: `story-archive:${capture.id}` }),
    ]);
    await supersedeStoryBeatArchive({ scene, docId: doc.id, beatId: 'beat-bg' });
    expect(Object.values(storyBook.entries).map((entry) => entry.content).join(' ')).not.toContain('Mara locked the observatory door.');
    expect(listLivingLoreWrites({ timelineId: scene.timelineId, status: 'written' })).toHaveLength(0);
});

test('production Story capture with no lorebook shows no packet and files nothing', async () => {
    __setExtensionSettings({ remodel: {}, connectionManager: { profiles: [{ id: 'loom-profile', name: 'Loom', api: 'openrouter', model: 'test/archive-model' }] } });
    const prompts = [];
    const runtime = createBackgroundArchiveRuntime({
        repository: createArchiveJobRepository({ persistence: createMemoryArchiveJobPersistence() }),
        transport: async ({ promptSnapshot }) => {
            prompts.push(promptSnapshot.messages.map((message) => message.content).join('\n'));
            return fence([], [{ content: 'Nowhere to file this.', evidence: ['x'] }]);
        },
        ingestion: createArchiveIngestion(legacyArchiveIngestionAdapter),
        commit: jest.fn(async () => ({ transactionId: null })),
    });
    setBackgroundArchiveRuntimeForTests(runtime);
    const { doc, capture } = makeCapture();
    const applied = await queueStoryArchiveCapture({ scene, docId: doc.id, captureId: capture.id });
    expect(applied.status).toBe('applied');
    expect(prompts[0]).not.toContain('Selected Living Lore (what the world already records about this scene):');
    expect(prompts[0]).not.toContain('=== WORLD SENSE RECALL ===');
    expect(applied.loreProposalIds).toEqual([]);
    expect(listLivingLoreWrites({ timelineId: scene.timelineId, status: 'written' })).toEqual([]);
});

// --- Recall on the PRODUCTION Story path --------------------------------------
//
// Without this, every Story pass started with amnesia about every other Scene
// and recorded known things as new. Recall is deterministic — keyword overlap
// between the passage and earlier Scenes' Archive — so this needs no vector
// backend: seed an earlier Scene's event, and the later Scene's pass sees it.

test('production Story capture shows the Loom what earlier Scenes already settled', async () => {
    __setExtensionSettings({ remodel: {
        timelineV1: {
            version: 1,
            timelineIds: [scene.timelineId],
            activeTimelineId: scene.timelineId,
            timelines: { [scene.timelineId]: { id: scene.timelineId, lorebookName: 'Living Story', arcIds: ['arc'] } },
            arcs: { arc: { id: 'arc', timelineId: scene.timelineId, title: 'Arrival', sceneIds: ['earlier-scene', scene.id] } },
            scenes: {
                'earlier-scene': { id: 'earlier-scene', timelineId: scene.timelineId, arcId: 'arc', title: 'The Cellar', mode: 'story' },
                [scene.id]: { ...scene, arcId: 'arc', title: 'The Observatory' },
            },
        },
        worldSenseV1: { version: 4, profile: { mode: 'suggest', maxEntries: 12, maxTokens: 1800 }, indexes: {}, receipts: [], continuityByScene: {} },
    }, connectionManager: { profiles: [{ id: 'loom-profile', name: 'Loom', api: 'openrouter', model: 'test/archive-model' }] } });
    __setContextOverrides({ loadWorldInfo: async () => ({ entries: {} }) });
    // Settled in an EARLIER Scene, and sharing words with the passage below.
    recordEvent(scene.timelineId, 'earlier-scene', 'Mara locked the observatory door for the night.');
    // Settled in THIS Scene: belongs in its own Archive, never in recall.
    recordEvent(scene.timelineId, scene.id, 'Mara counted the lantern oil.');

    const prompts = [];
    const runtime = createBackgroundArchiveRuntime({
        repository: createArchiveJobRepository({ persistence: createMemoryArchiveJobPersistence() }),
        transport: async ({ promptSnapshot }) => {
            prompts.push(promptSnapshot.messages.map((message) => message.content).join('\n'));
            return fence([]);
        },
        ingestion: createArchiveIngestion(legacyArchiveIngestionAdapter),
        commit: jest.fn(async () => ({ transactionId: null })),
    });
    setBackgroundArchiveRuntimeForTests(runtime);
    const doc = createStoryDoc({ title: 'Recall' });
    updateStoryDoc(doc.id, { body: 'Mara locked the observatory door.' });
    const capture = createStoryArchiveCapture(doc.id, { text: 'Mara locked the observatory door.', start: 0, end: 33, generationId: 'story-generation-recall' });

    const applied = await queueStoryArchiveCapture({ scene, docId: doc.id, captureId: capture.id });
    expect(applied.status).toBe('applied');
    expect(prompts).toHaveLength(1);
    const text = prompts[0];
    const prevStart = text.indexOf('## Earlier Scenes');
    // Earlier Scenes' events reach the Loom via prev.events, read directly.
    expect(prevStart).toBeGreaterThan(0);
    expect(text).toContain('Mara locked the observatory door for the night.');
    // prev.events is earlier Scenes only. The current Scene's own event is in its
    // own Archive (loom.events) and must not appear inside prev.events.
    const prev = text.slice(prevStart, text.indexOf('Selected Living Lore'));
    expect(prev).not.toContain('lantern oil');
    const beforePrev = text.slice(0, prevStart);
    expect(beforePrev).toContain('Mara counted the lantern oil.');
    // The current Scene's own events sit above the earlier-Scene prev.events.
    expect(prevStart).toBeGreaterThan(text.indexOf('Mara counted the lantern oil.'));
});
