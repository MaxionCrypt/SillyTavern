import { __setExtensionSettings } from './util/st-context-stub.js';
import {
    setSceneFact, clearSceneFact, listSceneFacts,
    recordEvent, updateEvent, deleteEvent, listEvents,
    setCharStateFacet, clearCharStateFacet, listCharStates,
    setBeat, getBeat,
    setSecret, clearSecret, listSecrets,
    snapshotArchivistStore, restoreArchivistStore, deleteArchivistForTimeline,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/archivist-store.js';

const T = 'tl-1';
const S = 'sc-1';

beforeEach(() => __setExtensionSettings({ remodel: {} }));

test('scene facts overwrite in place and clear', () => {
    setSceneFact(T, S, 'location', 'rooftop');
    setSceneFact(T, S, 'location', 'alley');
    expect(listSceneFacts(T, S)).toEqual([{ key: 'location', value: 'alley', establishedMsgId: null }]);
    clearSceneFact(T, S, 'location');
    expect(listSceneFacts(T, S)).toEqual([]);
});

test('events append in seq order', () => {
    recordEvent(T, S, 'Marcus drew his knife');
    recordEvent(T, S, 'Rain began to fall');
    const events = listEvents(T, S);
    expect(events.map((e) => e.summary)).toEqual(['Marcus drew his knife', 'Rain began to fall']);
    expect(events.map((e) => e.seq)).toEqual([0, 1]);
});

test('an owner can correct an event without replacing its provenance', () => {
    const original = recordEvent(T, S, 'Marcus drew a sword', { msgId: 12, turnIndex: 4 });
    const corrected = updateEvent(T, S, original.id, 'Marcus drew a knife');

    expect(corrected).toMatchObject({
        before: { id: original.id, summary: 'Marcus drew a sword', msgId: 12, turnIndex: 4, seq: original.seq, at: original.at },
        after: { id: original.id, summary: 'Marcus drew a knife', msgId: 12, turnIndex: 4, seq: original.seq, at: original.at },
    });
    expect(listEvents(T, S)).toEqual([expect.objectContaining({ id: original.id, summary: 'Marcus drew a knife' })]);
});

test('an owner can remove exactly one Archive event', () => {
    const first = recordEvent(T, S, 'Marcus drew his knife');
    const second = recordEvent(T, S, 'Rain began to fall');

    expect(deleteEvent(T, S, first.id)).toMatchObject({ id: first.id, summary: 'Marcus drew his knife' });
    expect(listEvents(T, S)).toEqual([expect.objectContaining({ id: second.id, summary: 'Rain began to fall' })]);
    expect(deleteEvent(T, S, 'missing')).toBeNull();
});

test('char state facets overwrite; clearing the last facet drops the record', () => {
    setCharStateFacet(T, S, 'marcus', 'mood', 'calm');
    setCharStateFacet(T, S, 'marcus', 'mood', 'desperate');
    setCharStateFacet(T, S, 'marcus', 'injury', 'cut left arm');
    expect(listCharStates(T, S)).toEqual([{ charId: 'marcus', facets: { mood: 'desperate', injury: 'cut left arm' } }]);
    clearCharStateFacet(T, S, 'marcus', 'injury');
    expect(listCharStates(T, S)).toEqual([{ charId: 'marcus', facets: { mood: 'desperate' } }]);
    clearCharStateFacet(T, S, 'marcus', 'mood');
    expect(listCharStates(T, S)).toEqual([]);
});

test('beat is a singleton the latest set replaces', () => {
    setBeat(T, S, 'Marcus hesitates', 'tense');
    setBeat(T, S, 'Marcus lunges', 'violent');
    expect(getBeat(T, S)).toEqual({ directive: 'Marcus lunges', tone: 'violent' });
});

test('secrets store and clear', () => {
    setSecret(T, S, 'betrayer', 'Marcus works for the guild');
    expect(listSecrets(T, S)).toEqual([{ key: 'betrayer', value: 'Marcus works for the guild' }]);
    clearSecret(T, S, 'betrayer');
    expect(listSecrets(T, S)).toEqual([]);
});

test('records are isolated per timeline and scene', () => {
    setSceneFact(T, S, 'location', 'rooftop');
    setSceneFact(T, 'sc-2', 'location', 'cellar');
    setSceneFact('tl-2', S, 'location', 'ship');
    expect(listSceneFacts(T, S)[0].value).toBe('rooftop');
    expect(listSceneFacts(T, 'sc-2')[0].value).toBe('cellar');
    expect(listSceneFacts('tl-2', S)[0].value).toBe('ship');
});

test('snapshot/restore round-trips and deleteForTimeline removes a timeline', () => {
    setSceneFact(T, S, 'location', 'rooftop');
    const snap = snapshotArchivistStore();
    setSceneFact(T, S, 'location', 'alley');
    restoreArchivistStore(snap, { save: false });
    expect(listSceneFacts(T, S)[0].value).toBe('rooftop');
    deleteArchivistForTimeline(T);
    expect(listSceneFacts(T, S)).toEqual([]);
});
