import { __setExtensionSettings } from './util/st-context-stub.js';
import { buildExtractionPrompt, archivistCapabilityGuide } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/narrator-extract.js';

beforeEach(() => __setExtensionSettings({ remodel: {} }));

test('the capability guide lists the archivist verbs and no variable/goal verbs', () => {
    const guide = archivistCapabilityGuide();
    for (const verb of ['event.record', 'scene.set', 'char_state.set', 'beat.set', 'secret.set']) {
        expect(guide).toContain(verb);
    }
    expect(guide).not.toContain('variable.create');
    expect(guide).not.toContain('goal.reach');
});

test('the extraction prompt asks for a state fence and carries the prose and reasoning', () => {
    const messages = buildExtractionPrompt({
        prose: 'Marcus drew his knife and lunged at Wren.',
        reasoning: 'Marcus is cornered, so he attacks.',
        currentState: '## Scene\n- location: rooftop',
    });
    const system = messages.find((m) => m.role === 'system').content;
    const user = messages.find((m) => m.role === 'user').content;
    expect(system).toContain('```state');
    expect(system).toContain('event.record');
    expect(system).toContain('rooftop'); // current state included so it is not re-recorded
    expect(user).toContain('Marcus drew his knife');
    expect(user).toContain('cornered'); // reasoning is the intent channel
});

test('reasoning and current state are optional', () => {
    const messages = buildExtractionPrompt({ prose: 'The rain stopped.' });
    expect(messages).toHaveLength(2);
    expect(messages[1].content).toContain('The rain stopped.');
});
