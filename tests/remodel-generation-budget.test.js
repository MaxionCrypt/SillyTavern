import { test, expect } from '@jest/globals';
import { describeGenerationBudget, describeBudgetWarning } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/generation-budget.js';

// The observed failure, from the debug journal on 2026-08-23: a 2000-token
// ceiling, reasoning_effort "high", 7780 characters of reasoning (~1950 tokens)
// and 900 characters of prose (~225) that ended mid-word at "under his las".
test('the real truncated turn is reported as budget exhaustion', () => {
    const budget = describeGenerationBudget({ visibleTokens: 225, reasoningTokens: 1950, maxTokens: 2000 });
    expect(budget.exhausted).toBe(true);
    expect(budget.used).toBe(2175);
    expect(Math.round(budget.reasoningShare * 100)).toBe(90);
});

test('a turn that finished well inside its budget is not flagged', () => {
    const budget = describeGenerationBudget({ visibleTokens: 400, reasoningTokens: 100, maxTokens: 2000 });
    expect(budget.exhausted).toBe(false);
});

// Client and provider tokenizers disagree by a percent or two, so landing just
// under the ceiling still means the ceiling was hit.
test('landing just under the ceiling counts as exhausted', () => {
    expect(describeGenerationBudget({ visibleTokens: 1975, maxTokens: 2000 }).exhausted).toBe(true);
    // ...but a comfortable margin does not.
    expect(describeGenerationBudget({ visibleTokens: 1900, maxTokens: 2000 }).exhausted).toBe(false);
});

// An unknown ceiling cannot be proven spent. Flagging every turn would train
// the reader to ignore the warning that matters.
test('an unknown or zero ceiling is never reported as exhausted', () => {
    for (const maxTokens of [0, null, undefined, '', NaN, -1]) {
        expect(describeGenerationBudget({ visibleTokens: 5000, maxTokens }).exhausted).toBe(false);
    }
});

// Number(null), Number('') and Number([]) are all 0. A silent 0 would read as
// "no tokens used" on a turn that merely failed to report.
test('unusable token counts coerce to zero without inventing usage', () => {
    const budget = describeGenerationBudget({ visibleTokens: null, reasoningTokens: '', maxTokens: 2000 });
    expect(budget.used).toBe(0);
    expect(budget.exhausted).toBe(false);
    expect(budget.reasoningShare).toBe(0);
});

test('a warning names the reasoning share and what to change', () => {
    const budget = describeGenerationBudget({ visibleTokens: 225, reasoningTokens: 1950, maxTokens: 2000 });
    const warning = describeBudgetWarning(budget, 'The Narrator draft');
    expect(warning).toContain('The Narrator draft');
    expect(warning).toContain('2000');
    expect(warning).toContain('90%');
    expect(warning).toMatch(/reasoning effort/i);
});

test('no warning when the budget was not exhausted', () => {
    const budget = describeGenerationBudget({ visibleTokens: 100, reasoningTokens: 0, maxTokens: 2000 });
    expect(describeBudgetWarning(budget)).toBe('');
    expect(describeBudgetWarning(null)).toBe('');
});

test('a non-reasoning truncation advises response length only', () => {
    const budget = describeGenerationBudget({ visibleTokens: 2000, reasoningTokens: 0, maxTokens: 2000 });
    expect(budget.exhausted).toBe(true);
    const warning = describeBudgetWarning(budget);
    expect(warning).toMatch(/Raise the response length\.$/);
    expect(warning).not.toMatch(/reasoning effort/i);
});

// Token counts are whole tokens. Flooring is what makes `used` comparable to a
// provider ceiling at all, and without it a fractional estimate would leak into
// the reported figures.
test('token counts are floored to whole tokens', () => {
    const budget = describeGenerationBudget({ visibleTokens: 10.7, reasoningTokens: 5.9, maxTokens: 2000 });
    expect(budget.visible).toBe(10);
    expect(budget.reasoning).toBe(5);
    expect(budget.used).toBe(15);
});
