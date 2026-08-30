import { expect, test } from '@jest/globals';
import {
    DEFAULT_REASONING_PREFIX,
    splitReasoning,
    stripReasoning,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/reasoning-strip.js';

const M = { prefix: '<think>', suffix: '</think>' };

test('a reply with no reasoning is returned untouched', () => {
    const text = 'She crossed the courtyard without looking back.';
    expect(splitReasoning(text, M)).toEqual({ found: false, prose: text, reasoning: '', blocks: 0 });
});

test('a leading block is removed and kept', () => {
    const result = splitReasoning('<think>She is angry but in control.</think>\n\nShe set the cup down.', M);
    expect(result.found).toBe(true);
    expect(result.prose).toBe('She set the cup down.');
    expect(result.reasoning).toBe('She is angry but in control.');
    expect(result.blocks).toBe(1);
});

test('several blocks are all removed and joined', () => {
    const result = splitReasoning('<think>one</think>A.<think>two</think>B.', M);
    expect(result.prose).toBe('A.B.');
    expect(result.reasoning).toBe('one\n\ntwo');
    expect(result.blocks).toBe(2);
});

test('an unclosed marker leaves the reply alone', () => {
    // Either the turn was cut off mid-thought, or the prose contains the marker.
    // Stripping to the end would delete a whole reply in the second case.
    const text = 'She paused. <think>what if';
    expect(splitReasoning(text, M)).toMatchObject({ found: false, prose: text });
});

test('a closing marker with no opening is left alone', () => {
    const text = 'She said "</think>" out loud, absurdly.';
    expect(splitReasoning(text, M)).toMatchObject({ found: false, prose: text });
});

test('an empty block is still a block, and still removed', () => {
    const result = splitReasoning('<think></think>The door opened.', M);
    expect(result.found).toBe(true);
    expect(result.prose).toBe('The door opened.');
});

test('prose surrounding a mid-reply block is preserved on both sides', () => {
    const result = splitReasoning('Before. <think>hm</think> After.', M);
    expect(result.prose).toBe('Before.  After.');
});

test('the gap a removed block leaves is closed up', () => {
    const result = splitReasoning('<think>x</think>\n\n\n\nShe moved.', M);
    expect(result.prose).toBe('She moved.');
});

test('custom markers are honoured rather than assuming think tags', () => {
    const result = splitReasoning('[REASON]a[/REASON]Prose.', { prefix: '[REASON]', suffix: '[/REASON]' });
    expect(result).toMatchObject({ found: true, prose: 'Prose.', reasoning: 'a' });
});

test('markers that do not match the reply change nothing', () => {
    const text = '<think>a</think>Prose.';
    expect(splitReasoning(text, { prefix: '[R]', suffix: '[/R]' })).toMatchObject({ found: false, prose: text });
});

test('empty and missing input do not throw', () => {
    for (const empty of ['', null, undefined]) {
        expect(splitReasoning(empty, M)).toMatchObject({ found: false, reasoning: '' });
    }
});

test('stripReasoning returns the prose alone', () => {
    expect(stripReasoning('<think>a</think>B.', M)).toBe('B.');
    expect(DEFAULT_REASONING_PREFIX).toBe('<think>');
});
