import { expect, jest, test } from '@jest/globals';
import {
    DEFAULT_NARRATOR_REASONING_MODE,
    getNarratorReasoningMode,
    normalizeNarratorReasoningMode,
    setNarratorReasoningMode,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/narrator-reasoning-policy.js';

function context() {
    return {
        extensionSettings: { remodel: {} },
        saveSettingsDebounced: jest.fn(),
    };
}

test('Narrator reasoning defaults to native and rejects unknown persisted values', () => {
    const c = context();
    expect(DEFAULT_NARRATOR_REASONING_MODE).toBe('native');
    expect(getNarratorReasoningMode('glm', c)).toBe('native');
    c.extensionSettings.remodel.narratorReasoningV1 = { profiles: { glm: 'made-up' } };
    expect(getNarratorReasoningMode('glm', c)).toBe('native');
    expect(normalizeNarratorReasoningMode('tagged')).toBe('tagged');
});

test('Narrator reasoning persists a non-default mode by Connection Profile', () => {
    const c = context();
    expect(setNarratorReasoningMode('deepseek', 'tagged', c)).toBe('tagged');
    expect(c.extensionSettings.remodel.narratorReasoningV1).toEqual({ profiles: { deepseek: 'tagged' } });
    expect(c.saveSettingsDebounced).toHaveBeenCalledTimes(1);
    expect(getNarratorReasoningMode('deepseek', c)).toBe('tagged');
    expect(getNarratorReasoningMode('glm', c)).toBe('native');
});

test('returning to native removes the profile override instead of storing a redundant default', () => {
    const c = context();
    setNarratorReasoningMode('glm', 'none', c);
    setNarratorReasoningMode('glm', 'native', c);
    expect(c.extensionSettings.remodel.narratorReasoningV1).toEqual({ profiles: {} });
});
