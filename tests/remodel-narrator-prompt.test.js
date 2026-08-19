import { compileNarratorPrompt, CAMERA_CONSTRAINT, narratorStreamBlock, buildDirectionInjection, APPEND_ONLY_DIRECTIVE } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/narrator-prompt.js';
import { __setContextOverrides } from './util/st-context-stub.js';

function baseInput(overrides = {}) {
    return {
        card: 'You are Marcus, a terse mercenary.',
        persona: 'The user plays Wren.',
        worldInfo: 'The city of Vell is under curfew.',
        archivistSections: '## Scene\n- location: rooftop',
        reasoning: 'Marcus should feel cornered and lash out.',
        recentHistory: [
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

test('recent history is the last content, in order, and continues the story', () => {
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
    const messages = compileNarratorPrompt({ card: '', persona: '', worldInfo: '', archivistSections: '', reasoning: '', recentHistory: [] });
    const system = messages.find((m) => m.role === 'system');
    expect(system).toBeTruthy();
    expect(system.content).toContain(CAMERA_CONSTRAINT);
});

describe('buildDirectionInjection', () => {
    test('always carries the append-only directive, even with no state', () => {
        const injection = buildDirectionInjection({});
        expect(injection).toContain(APPEND_ONLY_DIRECTIVE);
        expect(injection).toMatch(/only what happens next/i);
    });
    test('includes archivist state and director direction when present', () => {
        const injection = buildDirectionInjection({
            archivistState: '## What has happened\n- Marcus drew his knife',
            directorDirection: 'Escalate the standoff.',
        });
        expect(injection).toContain(APPEND_ONLY_DIRECTIVE);
        expect(injection).toContain('Marcus drew his knife');
        expect(injection).toContain('Escalate the standoff.');
    });
    test('the directive comes first, before the state', () => {
        const injection = buildDirectionInjection({ archivistState: '## Scene\n- location: rooftop' });
        expect(injection.indexOf(APPEND_ONLY_DIRECTIVE)).toBeLessThan(injection.indexOf('rooftop'));
    });
});

describe('narratorStreamBlock', () => {
    test('returns empty when Chat Completion streaming is available', () => {
        __setContextOverrides({ mainApi: 'openai', chatCompletionSettings: { stream_openai: true } });
        expect(narratorStreamBlock()).toBe('');
    });
    test('returns a clear reason when the backend cannot stream', () => {
        __setContextOverrides({ mainApi: 'textgenerationwebui', chatCompletionSettings: { stream_openai: false } });
        const reason = narratorStreamBlock();
        expect(reason).not.toBe('');
        expect(reason.toLowerCase()).toContain('stream');
    });
});
