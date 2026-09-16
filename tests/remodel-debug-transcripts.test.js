// STRUCTURAL regression checks for the two transports that intentionally
// bypass Prompt Studio's normal core-generation hook. The live browser is the
// integration gate; these make sure a later refactor cannot silently restore
// request/response asymmetry in the Debug Console.
import fs from 'node:fs';

const liveDirection = fs.readFileSync(
    new URL('../public/scripts/extensions/third-party/SillyTavern-Remodel/live-direction.js', import.meta.url), 'utf8');
const backgroundArchive = fs.readFileSync(
    new URL('../public/scripts/extensions/third-party/SillyTavern-Remodel/background-archive-runtime.js', import.meta.url), 'utf8');

test('the canonical Narrator stream records its captured request before delivery starts', () => {
    const start = liveDirection.indexOf('async function generateCanonicalNarrator');
    const body = liveDirection.slice(start, liveDirection.indexOf('function createCanonicalMessageStore', start));
    expect(body).toContain('recordNarratorPromptTranscript(prompt);');
    expect(body.indexOf('recordNarratorPromptTranscript(prompt);')).toBeLessThan(body.indexOf('const session = delivery.start'));
});

test('the background Archive records both its full Loom response and a correlated worker receipt', () => {
    const start = backgroundArchive.indexOf('const response = await streamChatPrompt');
    const body = backgroundArchive.slice(start, backgroundArchive.indexOf('return response;', start));
    expect(body).toContain("recordApiTranscript('response'");
    expect(body).toContain("recordDebugEvent('archive-worker', 'response.received'");
    expect(body).toContain('correlationId: job.jobId');
});
