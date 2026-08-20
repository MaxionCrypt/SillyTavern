import { __setExtensionSettings } from './util/st-context-stub.js';
import { buildExtractionPrompt, archivistCapabilityGuide, buildArchivistPrompt } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/narrator-extract.js';

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

test('the archivist-first prompt carries the action + prior narration and resolves mechanics, not beats', () => {
    const messages = buildArchivistPrompt({
        action: 'I try to seduce the cheerleader.',
        priorProse: 'Marissa sat by the window, sipping tea.',
        priorReasoning: 'She is guarded.',
        currentState: '## Scene\n- location: cafe',
        mechanicsSkill: '- Goal "Seduce Marissa" (30%)',
    });
    const system = messages.find((m) => m.role === 'system').content;
    const user = messages.find((m) => m.role === 'user').content;
    expect(system).toContain('```state');
    expect(system).toMatch(/goal\.reach/i);          // resolves attempts as rolls
    expect(system).toMatch(/not set beats|never .*what happens next/i);
    expect(system).toContain('Seduce Marissa');       // advertised mechanics
    expect(user).toContain('I try to seduce the cheerleader.');  // the action
    expect(user).toContain('Marissa sat by the window');         // prior narration
    expect(user).toContain('She is guarded.');                   // prior reasoning
});

test('the archivist-first prompt works with no prior narration (first turn)', () => {
    const messages = buildArchivistPrompt({ action: 'I open the journal.' });
    expect(messages[1].content).toContain('I open the journal.');
    expect(messages[1].content).not.toMatch(/previous narration/i);
});

test('the archivist prompt forbids meta-commentary and allows an empty result', () => {
    // DeepSeek (2026-08-19) recorded "The Archivist acknowledges the user's
    // instruction to continue…" as an event. The prompt must forbid meta and
    // explicitly allow returning nothing.
    const system = buildArchivistPrompt({ action: 'Continue.' }).find((m) => m.role === 'system').content;
    expect(system).toMatch(/never record.*(acknowledg|instruction|meta)/i);
    expect(system).toMatch(/"requests":\[\]/);
});

test('a mechanics skill block invites variable/goal consequences; without it, only narrative', () => {
    const withMechanics = buildExtractionPrompt({ prose: 'Wren bled.', mechanicsSkill: "- Wren's HP: 12" }).find((m) => m.role === 'system').content;
    expect(withMechanics).toContain("Wren's HP");
    expect(withMechanics).toMatch(/Variables and Goals/i);

    const withoutMechanics = buildExtractionPrompt({ prose: 'Wren bled.' }).find((m) => m.role === 'system').content;
    expect(withoutMechanics).not.toMatch(/advertised below/i);
});
