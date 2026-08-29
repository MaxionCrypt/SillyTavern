import { compileArchivePrompt } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/background-archive-runtime.js';

const block = (id, role, content) => ({ id, kind: 'message', role, content, enabled: true });
const recipe = (...contents) => ({
    id: 'loom-1', name: 'Loom', mode: 'loom', apiType: 'chat',
    blocks: contents.map((content, index) => block(`b${index}`, 'system', content)),
});

const input = {
    acceptedProse: 'She crossed the room.',
    currentPlayerAction: 'I cross the room.',
    archiveContext: 'The gate is open.',
    lifecycleProjection: { goals: true, variables: true },
    lifecycleContext: '[EXISTING TIMELINE LIFECYCLE — exact addresses]\nGOALS — none currently open.',
};

const joined = (compiled) => compiled.messages.map((message) => message.content).join('\n---\n');

test('the policy and contract are always present', () => {
    const compiled = compileArchivePrompt({ ...input, recipe: recipe('{{loom.archive}}') });
    expect(joined(compiled)).toContain("You are the Loom's background Archive clerk");
    expect(joined(compiled)).toContain('Output NOTHING except one state fence');
});

test('a source the recipe does not place is not appended behind the owner', () => {
    // Only the Archive state is placed; nothing else may smuggle itself in.
    const compiled = compileArchivePrompt({ ...input, recipe: recipe('{{loom.archive}}') });
    const text = joined(compiled);
    expect(text).toContain('Current Loom Archive:');
    expect(text).not.toContain('I cross the room.');
    expect(text).not.toContain('She crossed the room.');
});

test('a placed source appears where the recipe puts it', () => {
    const compiled = compileArchivePrompt({ ...input, recipe: recipe('{{player.action}}', '{{narrator.draft}}') });
    const text = joined(compiled);
    expect(text).toContain('I cross the room.');
    expect(text).toContain('She crossed the room.');
});

test('removing every source leaves only the policy and contract', () => {
    const compiled = compileArchivePrompt({ ...input, recipe: recipe('Just my own words.') });
    const text = joined(compiled);
    expect(text).toContain('Just my own words.');
    expect(text).not.toContain('Current Loom Archive:');
    expect(text).not.toContain('I cross the room.');
});

test('an unplaced lifecycle board still rides on the mechanics board', () => {
    const compiled = compileArchivePrompt({ ...input, recipe: recipe('{{loom.mechanics}}') });
    expect(joined(compiled)).toContain('EXISTING TIMELINE LIFECYCLE');
});

test('a placed lifecycle board follows the recipe order, not the mechanics board', () => {
    // Adjacent same-role blocks merge into one message, so position is what is
    // observable here, not message count.
    const after = joined(compileArchivePrompt({ ...input, recipe: recipe('{{loom.mechanics}}', '{{loom.lifecycle}}') }));
    expect(after.indexOf('event.record')).toBeLessThan(after.indexOf('EXISTING TIMELINE LIFECYCLE'));

    const before = joined(compileArchivePrompt({ ...input, recipe: recipe('{{loom.lifecycle}}', '{{loom.mechanics}}') }));
    expect(before.indexOf('EXISTING TIMELINE LIFECYCLE')).toBeLessThan(before.indexOf('event.record'));
});

test('a placed lifecycle board is not also duplicated into the mechanics board', () => {
    const text = joined(compileArchivePrompt({ ...input, recipe: recipe('{{loom.mechanics}}', '{{loom.lifecycle}}') }));
    expect(text.split('EXISTING TIMELINE LIFECYCLE')).toHaveLength(2);
});

test('a disabled block does not count as placing its source', () => {
    const withDisabled = recipe('{{loom.mechanics}}', '{{loom.lifecycle}}');
    withDisabled.blocks[1].enabled = false;
    const compiled = compileArchivePrompt({ ...input, recipe: withDisabled });
    // The lifecycle board falls back onto the mechanics board rather than vanishing.
    expect(joined(compiled)).toContain('EXISTING TIMELINE LIFECYCLE');
});
