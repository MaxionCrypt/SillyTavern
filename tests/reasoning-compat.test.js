import { test, expect } from '@jest/globals';
import {
    normalizeReasoningEffortForModel,
    openRouterModelRequiresReasoning,
} from '../public/scripts/reasoning-compat.js';

test('GLM 5.3 cannot be sent OpenRouter reasoning effort none', () => {
    expect(openRouterModelRequiresReasoning('z-ai/glm-5.3')).toBe(true);
    expect(normalizeReasoningEffortForModel('openrouter', 'z-ai/glm-5.3', 'none')).toBe('low');
    expect(normalizeReasoningEffortForModel('openrouter', 'z-ai/glm-5.3-20260816', 'min')).toBe('low');
});

test('compatible models and other providers retain the selected effort', () => {
    expect(normalizeReasoningEffortForModel('openrouter', 'deepseek/deepseek-v4-pro', 'none')).toBe('none');
    expect(normalizeReasoningEffortForModel('custom', 'z-ai/glm-5.3', 'none')).toBe('none');
    expect(normalizeReasoningEffortForModel('openrouter', 'z-ai/glm-5.3', 'high')).toBe('high');
});
