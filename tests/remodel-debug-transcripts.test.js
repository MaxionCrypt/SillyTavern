// STRUCTURAL regression checks for the two transports that intentionally
// bypass Prompt Studio's normal core-generation hook. The live browser is the
// integration gate; these make sure a later refactor cannot silently restore
// request/response asymmetry in the Debug Console.
import fs from 'node:fs';

const liveDirection = fs.readFileSync(
    new URL('../public/scripts/extensions/third-party/SillyTavern-Remodel/live-direction.js', import.meta.url), 'utf8');

test('the canonical Narrator stream records its captured request before delivery starts', () => {
    const start = liveDirection.indexOf('async function generateCanonicalNarrator');
    const body = liveDirection.slice(start, liveDirection.indexOf('function createCanonicalMessageStore', start));
    expect(body).toContain('recordNarratorPromptTranscript(prompt);');
    expect(body.indexOf('recordNarratorPromptTranscript(prompt);')).toBeLessThan(body.indexOf('const session = delivery.start'));
});
