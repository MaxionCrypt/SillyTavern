import { beforeEach, expect, test } from '@jest/globals';
import { applyLivingLoreIntake } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/living-lore-writer.js';
import { removeBlock, withdrawLivingLoreWrites } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/living-lore-withdrawal.js';
import { listLivingLoreWrites } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/living-lore-store.js';
import { __setContextOverrides, __setExtensionSettings } from './util/st-context-stub.js';

const BOOK = 'Test Book';
const TIMELINE = 'timeline-1';
let book;

beforeEach(() => {
    __setExtensionSettings({ remodel: {} });
    book = { entries: { 0: { uid: 0, key: ['Halloway'], keysecondary: [], comment: 'Halloway Residence', content: 'A house on the hill.', disable: false } } };
    __setContextOverrides({
        async loadWorldInfo() { return structuredClone(book); },
        async saveWorldInfo(name, data) { book = structuredClone(data); },
    });
});

const file = (content, source, placement = { decision: 'append', target: { book: BOOK, uid: '0' } }) => applyLivingLoreIntake({
    timelineId: TIMELINE, book: BOOK, placement, information: { content, name: 'New Thing', keys: ['thing'], evidence: ['e'] }, source,
});

test('a superseded turn takes its appended lore back out', async () => {
    await file('Teo left before dawn.', { directionId: 'dir-1' });
    expect(book.entries[0].content).toContain('Teo left before dawn.');

    const result = await withdrawLivingLoreWrites({ timelineId: TIMELINE, directionIds: ['dir-1'], reason: 'retry' });
    expect(result.ok).toBe(true);
    expect(book.entries[0].content).toBe('A house on the hill.');
});

test('withdrawal deletes an entry that existed only for the withdrawn information', async () => {
    await file('A courier refuses to say who sent her.', { directionId: 'dir-1' }, { decision: 'create' });
    const created = Object.values(book.entries).find((entry) => entry.comment === 'New Thing');
    expect(created).toBeTruthy();

    await withdrawLivingLoreWrites({ timelineId: TIMELINE, directionIds: ['dir-1'] });
    expect(Object.values(book.entries).some((entry) => entry.comment === 'New Thing')).toBe(false);
});

test('only the superseded turn is withdrawn, not everything in the entry', async () => {
    await file('First fact.', { directionId: 'dir-1' });
    await file('Second fact.', { directionId: 'dir-2' });
    await withdrawLivingLoreWrites({ timelineId: TIMELINE, directionIds: ['dir-1'] });
    expect(book.entries[0].content).not.toContain('First fact.');
    expect(book.entries[0].content).toContain('Second fact.');
});

test('an entry edited since is left alone rather than rewritten around', async () => {
    await file('Teo left before dawn.', { directionId: 'dir-1' });
    book.entries[0].content = 'A house on the hill.\n\nTeo departed at first light.';
    const result = await withdrawLivingLoreWrites({ timelineId: TIMELINE, directionIds: ['dir-1'] });
    expect(result.ok).toBe(false);
    expect(result.failed[0].code).toBe('content-changed');
    expect(book.entries[0].content).toContain('Teo departed at first light.');
});

test('a withdrawn write is not withdrawn twice', async () => {
    await file('Teo left before dawn.', { directionId: 'dir-1' });
    await withdrawLivingLoreWrites({ timelineId: TIMELINE, directionIds: ['dir-1'] });
    expect(listLivingLoreWrites({ timelineId: TIMELINE, status: 'written' })).toHaveLength(0);

    book.entries[0].content = 'A house on the hill.\n\nTeo left before dawn.';
    const second = await withdrawLivingLoreWrites({ timelineId: TIMELINE, directionIds: ['dir-1'] });
    expect(second.withdrawn).toHaveLength(0);
    expect(book.entries[0].content).toContain('Teo left before dawn.');
});

test('withdrawing an untouched turn changes nothing', async () => {
    await file('Teo left before dawn.', { directionId: 'dir-1' });
    const result = await withdrawLivingLoreWrites({ timelineId: TIMELINE, directionIds: ['dir-other'] });
    expect(result.withdrawn).toHaveLength(0);
    expect(book.entries[0].content).toContain('Teo left before dawn.');
});

test('withdrawal without any target is a no-op rather than a wipe', async () => {
    await file('Teo left before dawn.', { directionId: 'dir-1' });
    const result = await withdrawLivingLoreWrites({ timelineId: TIMELINE });
    expect(result.withdrawn).toHaveLength(0);
    expect(book.entries[0].content).toContain('Teo left before dawn.');
});

test('removing a block takes its separator with it', () => {
    expect(removeBlock('A.\n\nB.', 'B.')).toEqual({ changed: true, content: 'A.' });
    expect(removeBlock('A.\n\nB.', 'A.')).toEqual({ changed: true, content: 'B.' });
    expect(removeBlock('A.', 'missing')).toEqual({ changed: false, content: 'A.' });
});

test('withdrawal after a retry leaves the retake in place', async () => {
    await file('The door was locked.', { directionId: 'dir-1' });
    await withdrawLivingLoreWrites({ timelineId: TIMELINE, directionIds: ['dir-1'], reason: 'retry-superseded-generation' });
    await file('The door stood open.', { directionId: 'dir-2' });
    expect(book.entries[0].content).toBe('A house on the hill.\n\nThe door stood open.');
});
