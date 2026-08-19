import {
    MECHANICS_PROTOCOL,
    executeMechanicsRequest,
    getCapabilityDictionary,
    REQUIRED_ARGUMENTS,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/mechanics-capabilities.js';
import { buildDirectionSources } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/direction-sources.js';
import {
    listSceneFacts, listEvents, listCharStates, getBeat, listSecrets,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/archivist-store.js';
import { __setExtensionSettings } from './util/st-context-stub.js';

const T = 'tl-arch';
const S = 'sc-arch';
const ARCHIVIST_VERBS = ['scene.set', 'scene.clear', 'event.record', 'char_state.set', 'char_state.clear', 'beat.set', 'secret.set', 'secret.clear'];

beforeEach(() => __setExtensionSettings({ remodel: {} }));

function run(requests) {
    return executeMechanicsRequest(
        { protocol: MECHANICS_PROTOCOL, requests },
        { timelineId: T, sceneId: S, variableRefs: new Map(), goalRefs: new Map() },
    );
}
function req(capability, args, id = 'r1') {
    return { id, capability, arguments: args, reason: 'because the scene demands it' };
}

test('the dictionary advertises every archivist verb', () => {
    const names = getCapabilityDictionary().map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining(ARCHIVIST_VERBS));
});

test('a batch of archivist requests applies to the store', () => {
    const result = run([
        req('scene.set', { key: 'location', value: 'rooftop' }, 'a'),
        req('event.record', { summary: 'Marcus drew his knife' }, 'b'),
        req('char_state.set', { charId: 'marcus', facet: 'mood', value: 'desperate' }, 'c'),
        req('beat.set', { directive: 'Marcus lunges', tone: 'tense' }, 'd'),
        req('secret.set', { key: 'betrayer', value: 'guild plant' }, 'e'),
    ]);
    expect(result.ok).toBe(true);
    expect(listSceneFacts(T, S)[0]).toMatchObject({ key: 'location', value: 'rooftop' });
    expect(listEvents(T, S).map((e) => e.summary)).toEqual(['Marcus drew his knife']);
    expect(listCharStates(T, S)[0].facets.mood).toBe('desperate');
    expect(getBeat(T, S)).toEqual({ directive: 'Marcus lunges', tone: 'tense' });
    expect(listSecrets(T, S)[0]).toEqual({ key: 'betrayer', value: 'guild plant' });
});

test('a missing required argument is refused, naming the argument', () => {
    const result = run([req('scene.set', { value: 'rooftop' })]); // no key
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('key');
    expect(listSceneFacts(T, S)).toEqual([]);
});

test('every archivist required argument is named in the Director prompt', () => {
    const { mechanicsSkill } = buildDirectionSources(
        { mechanics: { capabilities: getCapabilityDictionary(), goals: [], serializedVariables: '', retrieval: {} } },
        { mechanicsEnabled: true },
    );
    for (const cap of ARCHIVIST_VERBS) {
        for (const [key] of REQUIRED_ARGUMENTS[cap]) {
            expect(`${cap} names ${key}: ${mechanicsSkill.includes(key)}`).toBe(`${cap} names ${key}: true`);
        }
    }
});
