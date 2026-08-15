import { formatMovementPrompt } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/live-direction.js';

const envelope = {
    directionId: 'direction-1',
    instruction: 'Let him land the blow, then let the room go quiet.',
    mechanics: { pendingRequests: [{ capability: 'variable.adjust', arguments: {} }] },
};

test('the movement prompt is the direction, with no marker instructions', () => {
    const prompt = formatMovementPrompt(envelope);
    expect(prompt).toContain('Let him land the blow');
    expect(prompt).not.toMatch(/\[\[RM:/);
    expect(prompt).not.toMatch(/marker/i);
    expect(prompt).not.toMatch(/checkpoint/i);
    expect(prompt).not.toMatch(/protocol/i);
});

test('it does not tell the performer about the Director', () => {
    expect(formatMovementPrompt(envelope)).not.toMatch(/director/i);
});

test('an empty instruction produces no prompt rather than an empty header', () => {
    expect(formatMovementPrompt({ ...envelope, instruction: '' })).toBe('');
});
