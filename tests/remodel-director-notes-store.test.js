import { appendDirectorEntries, readNarratorEntries, readAllEntries, deleteDirectorEntry } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/director-notes-store.js';

const TL = 'tl-test';

test('secrets are withheld from the Narrator read but kept for the owner', () => {
    appendDirectorEntries(TL, { sceneId: 's1', turn: 1, entries: [
        { type: 'note', text: 'Teo stalls.' },
        { type: 'secret', text: 'He saw the janitor.' },
    ] });
    const narrator = readNarratorEntries(TL, { sceneId: 's1', depth: 10 });
    expect(narrator.map((e) => e.type)).toEqual(['note']);
    expect(JSON.stringify(narrator)).not.toContain('janitor');
    expect(readAllEntries(TL, { sceneId: 's1' }).map((e) => e.type)).toEqual(['note', 'secret']);
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
    expect(readAllEntries(TL, { sceneId: 's3' })).toEqual([]);
});

test('an unknown type is rejected rather than stored', () => {
    const stored = appendDirectorEntries(TL, { sceneId: 's4', turn: 1, entries: [{ type: 'foreshadow', text: 'nope' }] });
    expect(stored).toEqual([]);
});
