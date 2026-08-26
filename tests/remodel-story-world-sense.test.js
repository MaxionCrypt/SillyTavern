import { expect, test } from '@jest/globals';
import {
    buildStoryWorldSenseOptions,
    formatStoryWorldSenseContinuity,
    storyWorldSenseLoreSelection,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/story-world-sense.js';

test('Story query uses bounded accepted manuscript and explicit beat without guidance or prompt diagnostics', () => {
    const paragraphs = Array.from({ length: 12 }, (_value, index) => `Accepted paragraph ${index + 1}.`);
    const doc = {
        body: paragraphs.join('\n\n'),
        guidance: 'SECRET AUTHOR GUIDANCE',
        prompt: 'COMPILED PROMPT',
        reasoning: 'PRIVATE REASONING',
    };
    const options = buildStoryWorldSenseOptions({
        doc,
        mode: 'beat',
        beat: 'Bring the harbor strike into the foreground.',
        cast: [{ label: 'Mara' }],
    });

    expect(options.action).toBe('Bring the harbor strike into the foreground.');
    expect(options.history).toHaveLength(8);
    expect(options.history[0].content).toBe('Accepted paragraph 5.');
    expect(JSON.stringify(options)).not.toMatch(/SECRET AUTHOR GUIDANCE|COMPILED PROMPT|PRIVATE REASONING/);
    expect(options.cast).toEqual([{ label: 'Mara' }]);
});

test('accepted capture passage becomes the Story Archive query action', () => {
    const options = buildStoryWorldSenseOptions({
        doc: { body: 'Earlier accepted manuscript.' },
        passage: 'The guild closes the western gate.',
        beat: 'An unaccepted instruction.',
    });
    expect(options.action).toBe('The guild closes the western gate.');
    expect(options.history[0].content).toBe('Earlier accepted manuscript.');
});

test('Story delivery keeps lore identities separate from provenance-labelled continuity', () => {
    const result = {
        book: 'Living Marches',
        selected: [
            { book: 'Living Marches', uid: '4', name: 'Old Harbor' },
            { kind: 'continuity', sceneId: 'story-1', sceneTitle: 'The Crossing', arcTitle: 'Arrival', recordType: 'event', text: 'Mara sealed the gate.' },
        ],
        continuity: [
            { kind: 'continuity', sceneId: 'story-1', sceneTitle: 'The Crossing', arcTitle: 'Arrival', recordType: 'event', text: 'Mara sealed the gate.' },
        ],
    };
    expect(storyWorldSenseLoreSelection(result)).toEqual({
        book: 'Living Marches',
        selected: [{ book: 'Living Marches', uid: '4', name: 'Old Harbor' }],
    });
    expect(formatStoryWorldSenseContinuity(result)).toContain('[Arrival / The Crossing / event] Mara sealed the gate.');
});

test('a large manuscript query stays tail-bounded and assembles inside the local budget', () => {
    const body = Array.from({ length: 20000 }, (_value, index) => `Accepted manuscript paragraph ${index}.`).join('\n\n');
    const startedAt = performance.now();
    const options = buildStoryWorldSenseOptions({ doc: { body }, mode: 'continue' });
    const elapsedMs = performance.now() - startedAt;
    const serialized = JSON.stringify(options);

    expect(options.history.length).toBeLessThanOrEqual(8);
    expect(serialized.length).toBeLessThan(7000);
    expect(serialized).toContain('Accepted manuscript paragraph 19999.');
    expect(serialized).not.toContain('Accepted manuscript paragraph 0.');
    expect(elapsedMs).toBeLessThan(250);
});
