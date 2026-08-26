import { beforeEach, expect, test } from '@jest/globals';
import {
    createStoryArchiveCapture,
    createStoryDoc,
    getStoryDoc,
    listStoryArchiveCaptures,
    previewStoryArchiveCatchUp,
    updateStoryArchiveCapture,
    updateStoryDoc,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/story-doc.js';
import { __setExtensionSettings } from './util/st-context-stub.js';

beforeEach(() => __setExtensionSettings({ remodel: {} }));

test('StoryDoc revisions advance only when manuscript prose changes', () => {
    const doc = createStoryDoc({ title: 'Shared Archive' });
    expect(doc.bodyRevision).toBe(0);
    updateStoryDoc(doc.id, { body: 'First passage.' });
    expect(getStoryDoc(doc.id).bodyRevision).toBe(1);
    updateStoryDoc(doc.id, { guidance: 'Keep the prose restrained.' });
    expect(getStoryDoc(doc.id).bodyRevision).toBe(1);
    updateStoryDoc(doc.id, { body: 'First passage.' });
    expect(getStoryDoc(doc.id).bodyRevision).toBe(1);
});

test('accepted Story passages have stable idempotent Archive provenance', () => {
    const doc = createStoryDoc({ title: 'Shared Archive' });
    updateStoryDoc(doc.id, { body: 'The bell rang.' });
    const first = createStoryArchiveCapture(doc.id, {
        text: 'The bell rang.', start: 0, end: 14, generationId: 'generation-1',
    });
    const duplicate = createStoryArchiveCapture(doc.id, {
        text: 'The bell rang.', start: 0, end: 14, generationId: 'generation-1',
    });
    expect(duplicate.id).toBe(first.id);
    expect(listStoryArchiveCaptures(doc.id)).toHaveLength(1);
    expect(first).toMatchObject({
        origin: 'story-narrator', bodyRevision: 1, start: 0, end: 14,
        status: 'pending', attempts: 0,
    });
    updateStoryArchiveCapture(doc.id, first.id, { status: 'applied', transactionId: 'tx-1' });
    expect(listStoryArchiveCaptures(doc.id)[0]).toMatchObject({ status: 'applied', transactionId: 'tx-1' });
});

test('regenerating one beat supersedes its prior capture without touching another beat', () => {
    const doc = createStoryDoc({ title: 'Beats' });
    updateStoryDoc(doc.id, { body: 'Old beat. Other beat.' });
    const oldBeat = createStoryArchiveCapture(doc.id, { text: 'Old beat.', start: 0, end: 9, generationId: 'g1', beatId: 'beat-1' });
    const otherBeat = createStoryArchiveCapture(doc.id, { text: 'Other beat.', start: 10, end: 21, generationId: 'g2', beatId: 'beat-2' });
    const replacement = createStoryArchiveCapture(doc.id, { text: 'New beat.', start: 0, end: 9, generationId: 'g3', beatId: 'beat-1' });
    expect(listStoryArchiveCaptures(doc.id).find((item) => item.id === oldBeat.id)?.status).toBe('superseded');
    expect(listStoryArchiveCaptures(doc.id).find((item) => item.id === otherBeat.id)?.status).toBe('pending');
    expect(replacement.status).toBe('pending');
});

test('a pre-provenance StoryDoc migrates without losing prose and becomes catch-up eligible', () => {
    __setExtensionSettings({ remodel: { storyDocsV1: {
        version: 1,
        docIds: ['legacy-story'],
        docs: {
            'legacy-story': {
                id: 'legacy-story', title: 'Legacy manuscript', body: 'The old observatory bell rang.',
                guidance: 'Keep the bell ominous.', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
            },
        },
    } } });

    const migrated = getStoryDoc('legacy-story');
    expect(migrated).toMatchObject({
        id: 'legacy-story', body: 'The old observatory bell rang.', guidance: 'Keep the bell ominous.',
        bodyRevision: 0, archiveCaptures: [],
    });
    const preview = previewStoryArchiveCatchUp(migrated.id);
    expect(preview).toMatchObject({ bodyRevision: 0, counts: { additions: 1, edits: 0, deletions: 0, retries: 0 } });
    expect(preview.changes[0]).toMatchObject({ afterText: migrated.body, start: 0, end: migrated.body.length });
});
