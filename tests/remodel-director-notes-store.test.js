import { appendDirectorEntries, readNarratorEntries, readAllEntriesForOwner, deleteDirectorEntry, updateDirectorEntry, readTurnReasoning } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/director-notes-store.js';
import { __getExtensionSettings } from './util/st-context-stub.js';

const TL = 'tl-test';

test('secrets are withheld from the Narrator read but kept for the owner', () => {
    appendDirectorEntries(TL, { sceneId: 's1', turn: 1, entries: [
        { type: 'note', text: 'Teo stalls.' },
        { type: 'secret', text: 'He saw the janitor.' },
    ] });
    const narrator = readNarratorEntries(TL, { sceneId: 's1', depth: 10 });
    expect(narrator.map((e) => e.type)).toEqual(['note']);
    expect(JSON.stringify(narrator)).not.toContain('janitor');
    expect(readAllEntriesForOwner(TL, { sceneId: 's1' }).map((e) => e.type)).toEqual(['note', 'secret']);
});

test('depth counts turns, not entries, so one turn is never half-delivered', () => {
    appendDirectorEntries(TL, { sceneId: 's2', turn: 1, entries: [{ type: 'note', text: 'one-a' }, { type: 'note', text: 'one-b' }] });
    appendDirectorEntries(TL, { sceneId: 's2', turn: 2, entries: [{ type: 'note', text: 'two-a' }] });
    const recent = readNarratorEntries(TL, { sceneId: 's2', depth: 1 });
    expect(recent.map((e) => e.text)).toEqual(['two-a']);
    const both = readNarratorEntries(TL, { sceneId: 's2', depth: 2 });
    expect(both.map((e) => e.text)).toEqual(['one-a', 'one-b', 'two-a']);
});

test('entries carry ids and are individually deletable', () => {
    const [entry] = appendDirectorEntries(TL, { sceneId: 's3', turn: 1, entries: [{ type: 'ruling', text: 'gone soon' }] });
    expect(entry.id).toBeTruthy();
    deleteDirectorEntry(TL, entry.id);
    expect(readAllEntriesForOwner(TL, { sceneId: 's3' })).toEqual([]);
});

test('an unknown type is rejected rather than stored', () => {
    const stored = appendDirectorEntries(TL, { sceneId: 's4', turn: 1, entries: [{ type: 'foreshadow', text: 'nope' }] });
    expect(stored).toEqual([]);
});

// Reads already filter dangling ids out (`.filter(Boolean)`), so a test that
// only checks the read API would still pass even if delete stopped pruning
// `entryIds` — the id would just leak in the persisted settings blob forever.
// This inspects the raw persisted bucket to make sure delete actually prunes it.
test('deleting an entry removes its id from the persisted store, not just from reads', () => {
    const [entry] = appendDirectorEntries(TL, { sceneId: 's5', turn: 1, entries: [{ type: 'note', text: 'temp' }] });
    deleteDirectorEntry(TL, entry.id);
    const bucket = __getExtensionSettings().remodel.directorNotesV1.timelines[TL];
    expect(bucket.entryIds).not.toContain(entry.id);
    expect(bucket.entries[entry.id]).toBeUndefined();
});

test('updateDirectorEntry edits text but cannot retype an entry', () => {
    const [entry] = appendDirectorEntries(TL, { sceneId: 's6', turn: 1, entries: [{ type: 'note', text: 'first draft' }] });
    const updated = updateDirectorEntry(TL, entry.id, { text: 'revised draft', type: 'secret' });
    expect(updated.text).toBe('revised draft');
    expect(updated.type).toBe('note');
    expect(readAllEntriesForOwner(TL, { sceneId: 's6' })[0]).toMatchObject({ text: 'revised draft', type: 'note' });
});

// --- readTurnReasoning: reasoning stored alongside entries -------------------

test('appendDirectorEntries stores reasoning alongside entries for the same turn', () => {
    appendDirectorEntries(TL, {
        sceneId: 's7',
        turn: 3,
        entries: [{ type: 'note', text: 'A quiet scene.' }],
        reasoning: 'The tension needs to build slowly here.',
    });
    expect(readTurnReasoning(TL, { sceneId: 's7', turn: 3 })).toBe('The tension needs to build slowly here.');
});

test('readTurnReasoning returns empty string when no reasoning was stored', () => {
    appendDirectorEntries(TL, {
        sceneId: 's8',
        turn: 4,
        entries: [{ type: 'note', text: 'No reasoning.' }],
    });
    expect(readTurnReasoning(TL, { sceneId: 's8', turn: 4 })).toBe('');
});

test('readTurnReasoning returns empty string for a nonexistent turn', () => {
    expect(readTurnReasoning(TL, { sceneId: 's9', turn: 999 })).toBe('');
});
