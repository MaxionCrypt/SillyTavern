import { test, expect } from '@jest/globals';
import { applyNarratorRetryPolicy } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/narrator-retry-policy.js';

test('a reasoning-only OpenRouter retry disables reasoning on that request', () => {
    const request = {
        chat_completion_source: 'openrouter',
        model: 'deepseek/deepseek-v4-pro',
        reasoning_effort: 'low',
        include_reasoning: true,
    };

    expect(applyNarratorRetryPolicy(request, { emptyRetries: 1, previousReasoningLength: 575 })).toBe(true);
    expect(request.reasoning_effort).toBe('none');
    expect(request.include_reasoning).toBe(false);
});

test('the first request and a genuinely silent retry preserve user settings', () => {
    const first = { chat_completion_source: 'openrouter', reasoning_effort: 'low', include_reasoning: true };
    const silent = { ...first };

    expect(applyNarratorRetryPolicy(first, { emptyRetries: 0, previousReasoningLength: 575 })).toBe(false);
    expect(applyNarratorRetryPolicy(silent, { emptyRetries: 1, previousReasoningLength: 0 })).toBe(false);
    expect(first).toEqual({ chat_completion_source: 'openrouter', reasoning_effort: 'low', include_reasoning: true });
    expect(silent).toEqual(first);
});

test('other providers are never rewritten', () => {
    const request = { chat_completion_source: 'custom', reasoning_effort: 'low', include_reasoning: true };

    expect(applyNarratorRetryPolicy(request, { emptyRetries: 1, previousReasoningLength: 575 })).toBe(false);
    expect(request).toEqual({ chat_completion_source: 'custom', reasoning_effort: 'low', include_reasoning: true });
});

test('invalid request data fails open', () => {
    expect(applyNarratorRetryPolicy(null, { emptyRetries: 1, previousReasoningLength: 575 })).toBe(false);
    expect(applyNarratorRetryPolicy({}, { emptyRetries: 1, previousReasoningLength: 575 })).toBe(false);
});
