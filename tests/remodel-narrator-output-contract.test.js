import { describeNarratorOutput } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/narrator-output-contract.js';

test('accepts ordinary narration, dialogue, and first-person prose', () => {
    for (const prose of [
        'The latch lifted. “Do not open that door,” Mara said.',
        'I need the blue key, Eli thought, watching the lock.',
        'Rules: three chalk lines crossed the cellar door.',
    ]) {
        expect(describeNarratorOutput(prose).malformed).toBe(false);
    }
});

test('rejects reasoning leaked into visible content', () => {
    const text = 'Hmm, the user wants me to focus on what is established. I need to recall the scene.\n\nThe lamp buzzed.';
    expect(describeNarratorOutput(text)).toMatchObject({ malformed: true, cause: 'reasoning-in-content' });
});

test('rejects copied prompt instructions', () => {
    const text = 'Do not provide conclusions from the story.\nDo not provide a story summary.\n\nThe lamp buzzed.';
    expect(describeNarratorOutput(text)).toMatchObject({ malformed: true, cause: 'instruction-echo' });
});

test('rejects Loom protocol returned by the Narrator', () => {
    const text = '{"swaps":[],"requests":[{"capability":"event.record"}]}';
    expect(describeNarratorOutput(text)).toMatchObject({ malformed: true, cause: 'protocol-output' });
});
