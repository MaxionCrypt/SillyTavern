import { beforeEach, expect, test } from '@jest/globals';
import {
    createStoryArchiveCapture,
    createStoryDoc,
    getStoryArchiveCapture,
    previewStoryArchiveCatchUp,
    updateStoryDoc,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/story-doc.js';
import { __setExtensionSettings } from './util/st-context-stub.js';
import { splitStoryArchiveAddition, STORY_ARCHIVE_PASSAGE_MAX_CHARS } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/story-archive-provenance.js';

beforeEach(() => __setExtensionSettings({ remodel: {} }));

test('uncaptured legacy and user-written prose is reported as exact additions', () => {
    const doc = createStoryDoc({ title: 'Legacy story' });
    updateStoryDoc(doc.id, { body: 'An older manuscript.\n\nA new continuation.' });
    const preview = previewStoryArchiveCatchUp(doc.id);
    expect(preview.counts).toEqual({ additions: 1, edits: 0, deletions: 0, retries: 0 });
    expect(preview.changes[0]).toMatchObject({
        type: 'addition', start: 0, end: 41, afterText: 'An older manuscript.\n\nA new continuation.', origin: 'user',
    });
});

test('provenance boundaries keep adjacent user prose out of a Narrator capture', () => {
    const doc = createStoryDoc({ title: 'Boundaries' });
    updateStoryDoc(doc.id, { body: 'Narrator passage.' });
    const capture = createStoryArchiveCapture(doc.id, {
        text: 'Narrator passage.', start: 0, end: 17, generationId: 'narrator-one',
    });
    updateStoryDoc(doc.id, { body: 'Preface.\n\nNarrator passage.\n\nUser continuation.' });

    expect(getStoryArchiveCapture(doc.id, capture.id)).toMatchObject({
        start: 10, end: 27, sourceStatus: 'current',
    });
    const preview = previewStoryArchiveCatchUp(doc.id);
    expect(preview.changes.map((change) => [change.type, change.afterText])).toEqual([
        ['addition', 'Preface.'],
        ['addition', 'User continuation.'],
    ]);
});

test('editing and deleting captured prose produces explicit before and after deltas', () => {
    const edited = createStoryDoc({ title: 'Edited' });
    updateStoryDoc(edited.id, { body: 'The door was open.' });
    const editCapture = createStoryArchiveCapture(edited.id, {
        text: 'The door was open.', start: 0, end: 18, generationId: 'edit-source',
    });
    updateStoryDoc(edited.id, { body: 'The door was locked.' });
    expect(previewStoryArchiveCatchUp(edited.id).changes[0]).toMatchObject({
        type: 'edit', beforeText: 'The door was open.', afterText: 'The door was locked.',
        supersedesCaptureIds: [editCapture.id],
    });

    const removed = createStoryDoc({ title: 'Deleted' });
    updateStoryDoc(removed.id, { body: 'Remove this event.' });
    const deleteCapture = createStoryArchiveCapture(removed.id, {
        text: 'Remove this event.', start: 0, end: 18, generationId: 'delete-source',
    });
    updateStoryDoc(removed.id, { body: '' });
    expect(previewStoryArchiveCatchUp(removed.id).changes[0]).toMatchObject({
        type: 'deletion', beforeText: 'Remove this event.', afterText: '',
        supersedesCaptureIds: [deleteCapture.id],
    });
});

test('preview token changes when autosave changes the manuscript', () => {
    const doc = createStoryDoc({ title: 'Concurrency' });
    updateStoryDoc(doc.id, { body: 'First draft.' });
    const before = previewStoryArchiveCatchUp(doc.id);
    updateStoryDoc(doc.id, { body: 'Second draft.' });
    const after = previewStoryArchiveCatchUp(doc.id);
    expect(after.token).not.toBe(before.token);
    expect(after.bodyRevision).toBeGreaterThan(before.bodyRevision);
});

test('large legacy additions split on exact bounded source spans', () => {
    const paragraph = 'A long accepted paragraph carries several facts for the Archive. '.repeat(40).trim();
    const text = Array.from({ length: 8 }, (_value, index) => `Section ${index + 1}. ${paragraph}`).join('\n\n');
    const change = { id: 'legacy', type: 'addition', start: 120, end: 120 + text.length, afterText: text };
    const parts = splitStoryArchiveAddition(change);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((part) => part.afterText.length <= STORY_ARCHIVE_PASSAGE_MAX_CHARS)).toBe(true);
    expect(parts.every((part) => text.slice(part.start - change.start, part.end - change.start) === part.afterText)).toBe(true);
    expect(parts.map((part) => part.part)).toEqual(parts.map((_part, index) => index + 1));
    expect(new Set(parts.map((part) => part.totalParts))).toEqual(new Set([parts.length]));
});

test('large-manuscript catch-up preview and capture splitting remain bounded', () => {
    const body = Array.from({ length: 7000 }, (_value, index) => `Passage ${index} records an accepted fact.`).join('\n\n');
    const doc = createStoryDoc({ title: 'Large manuscript performance' });
    updateStoryDoc(doc.id, { body });
    const startedAt = performance.now();
    const preview = previewStoryArchiveCatchUp(doc.id);
    const parts = preview.changes.flatMap((change) => splitStoryArchiveAddition(change));
    const elapsedMs = performance.now() - startedAt;

    expect(preview.changes).toHaveLength(1);
    expect(parts.length).toBeGreaterThan(20);
    expect(parts.every((part) => part.afterText.length <= STORY_ARCHIVE_PASSAGE_MAX_CHARS)).toBe(true);
    expect(parts.map((part) => part.afterText).join('\n\n').replace(/\s+/g, ' ').trim()).toBe(body.replace(/\s+/g, ' ').trim());
    // A roughly 280 KB legacy manuscript remains interactive even under Jest's
    // instrumented VM. Individual API captures are still capped at 6 KB.
    expect(elapsedMs).toBeLessThan(2500);
});
