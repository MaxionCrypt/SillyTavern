import { beforeEach, expect, test } from '@jest/globals';
import { applyLivingLoreIntake, MAX_ENTRY_CHARS } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/living-lore-writer.js';
import { __setContextOverrides, __setExtensionSettings } from './util/st-context-stub.js';

const BOOK = 'Test Book';
let book;
let saves;

beforeEach(() => {
    __setExtensionSettings({ remodel: {} });
    book = { entries: { 0: { uid: 0, key: ['Halloway'], keysecondary: [], comment: 'Halloway Residence', content: 'A house on the hill.', disable: false } } };
    saves = [];
    __setContextOverrides({
        async loadWorldInfo() { return structuredClone(book); },
        async saveWorldInfo(name, data) { saves.push(name); book = structuredClone(data); },
    });
});

const info = (content, extra = {}) => ({ content, name: '', keys: [], evidence: ['e'], ...extra });

test('an append adds content to the end and keeps the existing header', async () => {
    const result = await applyLivingLoreIntake({
        timelineId: 't', book, placement: { decision: 'append', target: { book: BOOK, uid: '0' } },
        information: info('Teo was seen leaving before dawn.'),
    });
    expect(result.ok).toBe(true);
    expect(result.decision).toBe('append');
    expect(book.entries[0].content).toBe('A house on the hill.\n\nTeo was seen leaving before dawn.');
    expect(book.entries[0].comment).toBe('Halloway Residence');
});

test('a create keeps the suggested name and keys', async () => {
    const result = await applyLivingLoreIntake({
        timelineId: 't', book, placement: { decision: 'create' },
        information: info('A courier refuses to say who sent her.', { name: 'The Courier', keys: ['courier', 'Courier'] }),
    });
    expect(result.decision).toBe('create');
    const created = Object.values(book.entries).find((entry) => entry.comment === 'The Courier');
    expect(created.key).toEqual(['courier', 'Courier']);
    expect(created.constant).toBe(false);
});

test('filing the same information twice does not write it twice', async () => {
    const once = { timelineId: 't', book, placement: { decision: 'append', target: { book: BOOK, uid: '0' } }, information: info('Teo was seen leaving before dawn.') };
    await applyLivingLoreIntake(once);
    const before = book.entries[0].content;
    const again = await applyLivingLoreIntake(once);
    expect(again.decision).toBe('already-recorded');
    expect(book.entries[0].content).toBe(before);
});

test('a retry cannot duplicate lore even when it would be placed elsewhere', async () => {
    await applyLivingLoreIntake({
        timelineId: 't', book, placement: { decision: 'append', target: { book: BOOK, uid: '0' } },
        information: info('Teo was seen leaving before dawn.'),
    });
    // Same information, now placed as its own entry: still already recorded.
    const retry = await applyLivingLoreIntake({
        timelineId: 't', book, placement: { decision: 'create' },
        information: info('Teo was seen leaving before dawn.', { name: 'Teo' }),
    });
    expect(retry.decision).toBe('already-recorded');
    expect(Object.keys(book.entries)).toHaveLength(1);
});

test('an oversized entry is refused rather than truncated', async () => {
    book.entries[0].content = 'x'.repeat(MAX_ENTRY_CHARS - 5);
    const result = await applyLivingLoreIntake({
        timelineId: 't', book, placement: { decision: 'append', target: { book: BOOK, uid: '0' } },
        information: info('This will not fit inside the ceiling.'),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('entry-too-large');
    expect(saves).toHaveLength(0);
});

test('a failed save restores the book rather than leaving it half written', async () => {
    const untouched = structuredClone(book);
    __setContextOverrides({
        async loadWorldInfo() { return structuredClone(untouched); },
        async saveWorldInfo(name, data) {
            saves.push(name);
            if (saves.length === 1) throw new Error('disk full');
            book = structuredClone(data);
        },
    });
    const result = await applyLivingLoreIntake({
        timelineId: 't', book, placement: { decision: 'append', target: { book: BOOK, uid: '0' } },
        information: info('Teo was seen leaving before dawn.'),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('save-failed');
    // Second save is the restore.
    expect(book.entries[0].content).toBe('A house on the hill.');
});

test('an append to a missing entry is refused, not silently created', async () => {
    const result = await applyLivingLoreIntake({
        timelineId: 't', book, placement: { decision: 'append', target: { book: BOOK, uid: '999' } },
        information: info('Something about nothing.'),
    });
    expect(result.reason).toBe('missing-entry');
});

test('empty content is refused before anything is loaded', async () => {
    const result = await applyLivingLoreIntake({ timelineId: 't', book, placement: { decision: 'create' }, information: info('   ') });
    expect(result.reason).toBe('empty-content');
});
