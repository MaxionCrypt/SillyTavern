import { __setExtensionSettings } from './util/st-context-stub.js';
import {
    setSceneFact, recordEvent, setCharStateFacet, setBeat, setSecret,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/archivist-store.js';
import { buildNarratorArchivistSections } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/narrator-prompt.js';

const T = 'tl-n';
const S = 'sc-n';

beforeEach(() => __setExtensionSettings({ remodel: {} }));

test('renders scene, characters, events, and beat as labelled sections', () => {
    setSceneFact(T, S, 'location', 'rain-soaked rooftop');
    setCharStateFacet(T, S, 'marcus', 'mood', 'desperate');
    recordEvent(T, S, 'Marcus drew his knife');
    setBeat(T, S, 'Marcus lunges', 'tense');
    const text = buildNarratorArchivistSections(T, S);
    expect(text).toContain('location: rain-soaked rooftop');
    expect(text).toContain('marcus');
    expect(text).toContain('mood: desperate');
    expect(text).toContain('Marcus drew his knife');
    expect(text).toContain('Marcus lunges');
    // the event log must be framed as already-written
    expect(text.toLowerCase()).toContain('already');
    // the beat must be framed as what happens next
    expect(text.toLowerCase()).toContain('next');
});

test('secrets never appear in the Narrator sections (fail-closed)', () => {
    setSceneFact(T, S, 'location', 'rooftop');
    setSecret(T, S, 'betrayer', 'Marcus works for the guild');
    const text = buildNarratorArchivistSections(T, S);
    expect(text).not.toContain('betrayer');
    expect(text).not.toContain('guild');
});

test('an empty scene renders as an empty string', () => {
    expect(buildNarratorArchivistSections(T, S)).toBe('');
});
