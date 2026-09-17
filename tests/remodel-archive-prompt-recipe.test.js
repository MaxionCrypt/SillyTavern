import { compileArchivePrompt } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/background-archive-runtime.js';
import { setSceneFact } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/archivist-store.js';
import { createTimelineGoal } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/story-goals-store.js';
import { __setExtensionSettings } from './util/st-context-stub.js';

const block = (id, role, content) => ({ id, kind: 'message', role, content, enabled: true });
const recipe = (...contents) => ({
    id: 'loom-1', name: 'Loom', mode: 'loom', apiType: 'chat',
    blocks: contents.map((content, index) => block(`b${index}`, 'system', content)),
});

const base = {
    acceptedProse: 'She crossed the room.',
    currentPlayerAction: 'I cross the room.',
    timelineId: 'tl-arch',
    sceneId: 'sc-arch',
};

const joined = (compiled) => compiled.messages.map((message) => message.content).join('\n---\n');

beforeEach(() => __setExtensionSettings({ remodel: {} }));

test('the recipe owns its policy and output contract', () => {
    const text = joined(compileArchivePrompt({ ...base, recipe: recipe('My Archive policy.', '{{loom.action}}', 'My Archive contract.') }));
    expect(text).toContain('My Archive policy.');
    expect(text).toContain('My Archive contract.');
    expect(text).not.toContain("You are the Loom's background Archive clerk");
    expect(text).not.toContain('Output NOTHING except one state fence');
});

test('a source the recipe does not place is not appended behind the owner', () => {
    // Only the player action is placed; the accepted prose (narrator.draft) may not smuggle itself in.
    const text = joined(compileArchivePrompt({ ...base, recipe: recipe('{{loom.action}}') }));
    expect(text).toContain('I cross the room.');
    expect(text).not.toContain('She crossed the room.');
});

test('a placed source appears where the recipe puts it', () => {
    const text = joined(compileArchivePrompt({ ...base, recipe: recipe('{{loom.action}}', '{{narrator.draft}}') }));
    expect(text).toContain('I cross the room.');
    expect(text).toContain('She crossed the room.');
});

test('removing every source leaves only the recipe authored by the owner', () => {
    const text = joined(compileArchivePrompt({ ...base, recipe: recipe('Just my own words.') }));
    expect(text).toContain('Just my own words.');
    expect(text).not.toContain('I cross the room.');
    expect(text).not.toContain('She crossed the room.');
    expect(text).not.toContain("You are the Loom's background Archive clerk");
});

test('split state macros are rooted in the live Scene, not a passed-in string', () => {
    setSceneFact('tl-arch', 'sc-arch', 'location', 'the observatory');
    createTimelineGoal('tl-arch', { title: 'Reach the vault', description: 'before dawn', successRate: 40 }, { actor: 'loom' });
    const text = joined(compileArchivePrompt({ ...base, recipe: recipe('{{loom.scene}}', '{{loom.goals secret=true}}') }));
    expect(text).toContain('- location: the observatory');
    expect(text).toContain('Reach the vault — 40%');
});

test('prev.events carries the earlier-Scene recall string', () => {
    const text = joined(compileArchivePrompt({ ...base, recall: '=== WORLD SENSE RECALL ===\n- the vault was sealed', recipe: recipe('{{prev.events}}') }));
    expect(text).toContain('the vault was sealed');
});
