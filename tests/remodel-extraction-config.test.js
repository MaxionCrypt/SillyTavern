import { __setExtensionSettings, __setContextOverrides } from './util/st-context-stub.js';
import {
    getExtractionProfileId,
    setExtractionProfileId,
    listExtractionProfiles,
    runExtraction,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/extraction-config.js';

beforeEach(() => __setExtensionSettings({ remodel: {} }));

test('the extraction profile id round-trips and defaults empty', () => {
    expect(getExtractionProfileId()).toBe('');
    setExtractionProfileId('profile-7');
    expect(getExtractionProfileId()).toBe('profile-7');
    setExtractionProfileId('');
    expect(getExtractionProfileId()).toBe('');
});

test('listExtractionProfiles reports the Connection Manager profiles', () => {
    __setExtensionSettings({
        remodel: {},
        connectionManager: { profiles: [
            { id: 'a', name: 'Reasoner', api: 'openai', model: 'deepseek-r1', junk: 1 },
            { id: 'b', name: 'Writer', api: 'openai', model: 'kimi' },
        ] },
    });
    expect(listExtractionProfiles()).toEqual([
        { id: 'a', name: 'Reasoner', api: 'openai', model: 'deepseek-r1' },
        { id: 'b', name: 'Writer', api: 'openai', model: 'kimi' },
    ]);
});

test('runExtraction routes to the configured profile via Connection Manager', async () => {
    __setExtensionSettings({
        remodel: { extractionProfileId: 'a' },
        connectionManager: { profiles: [{ id: 'a', name: 'Reasoner' }] },
        disabledExtensions: [],
    });
    const calls = [];
    __setContextOverrides({
        ConnectionManagerRequestService: {
            async sendRequest(profileId, prompt, maxTokens, custom) {
                calls.push({ profileId, prompt, maxTokens, stream: custom?.stream });
                return { content: '```state\n{"requests":[],"flow":{"continue":false}}\n```' };
            },
        },
    });
    const raw = await runExtraction([{ role: 'user', content: 'what happened' }]);
    expect(calls).toHaveLength(1);
    expect(calls[0].profileId).toBe('a');
    expect(calls[0].stream).toBe(false);
    expect(raw).toContain('```state');
});

test('runExtraction ignores the profile when Connection Manager is disabled', async () => {
    __setExtensionSettings({
        remodel: { extractionProfileId: 'a' },
        connectionManager: { profiles: [{ id: 'a', name: 'Reasoner' }] },
        disabledExtensions: ['connection-manager'],
    });
    let cmCalled = false;
    __setContextOverrides({
        ConnectionManagerRequestService: { async sendRequest() { cmCalled = true; return { content: '' }; } },
        // Stub the active-connection transport so the fallback doesn't hit a real backend.
        __streamChatPromptStub: async () => ({ text: 'FALLBACK' }),
    });
    const raw = await runExtraction([{ role: 'user', content: 'x' }]);
    expect(cmCalled).toBe(false);
    expect(raw).toBe('FALLBACK');
});
