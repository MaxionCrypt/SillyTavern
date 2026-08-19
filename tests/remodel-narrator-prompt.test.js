import { compileNarratorPrompt, CAMERA_CONSTRAINT } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/narrator-prompt.js';

function baseInput(overrides = {}) {
    return {
        card: 'You are Marcus, a terse mercenary.',
        persona: 'The user plays Wren.',
        worldInfo: 'The city of Vell is under curfew.',
        archivistSections: '## Scene\n- location: rooftop',
        reasoning: 'Marcus should feel cornered and lash out.',
        voiceWindow: [
            { role: 'assistant', content: 'Marcus watched the door.' },
            { role: 'user', content: 'I step closer.' },
        ],
        ...overrides,
    };
}

test('the system message carries the card, persona, and camera constraint', () => {
    const messages = compileNarratorPrompt(baseInput());
    const system = messages.find((m) => m.role === 'system');
    expect(system.content).toContain('Marcus, a terse mercenary');
    expect(system.content).toContain('The user plays Wren');
    expect(system.content).toContain(CAMERA_CONSTRAINT);
});

test('world info, archivist state, and reasoning each appear as content', () => {
    const joined = compileNarratorPrompt(baseInput()).map((m) => m.content).join('\n');
    expect(joined).toContain('under curfew');
    expect(joined).toContain('location: rooftop');
    expect(joined).toContain('cornered and lash out');
});

test('the voice window is the last content, in order, and is the only prior prose', () => {
    const messages = compileNarratorPrompt(baseInput());
    const tail = messages.slice(-2);
    expect(tail).toEqual([
        { role: 'assistant', content: 'Marcus watched the door.' },
        { role: 'user', content: 'I step closer.' },
    ]);
});

test('an absent reasoning bridge is simply omitted (no empty block)', () => {
    const messages = compileNarratorPrompt(baseInput({ reasoning: '' }));
    expect(messages.every((m) => m.content.trim().length > 0)).toBe(true);
});

test('empty optional inputs still yield a valid system message', () => {
    const messages = compileNarratorPrompt({ card: '', persona: '', worldInfo: '', archivistSections: '', reasoning: '', voiceWindow: [] });
    const system = messages.find((m) => m.role === 'system');
    expect(system).toBeTruthy();
    expect(system.content).toContain(CAMERA_CONSTRAINT);
});
