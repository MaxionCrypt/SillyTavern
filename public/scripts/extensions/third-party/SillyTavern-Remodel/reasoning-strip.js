// Keep a turn's reasoning out of the turns that follow.
//
// A model asked to think before writing produces reasoning worth having once
// and worth carrying never. Left in the accepted prose it becomes history: the
// next turn reads it, the turn after reads both, and within a few exchanges the
// context is mostly the model talking to itself about what it was about to
// write. It also teaches the model that reasoning is part of the register,
// which is how the analytical voice leaks into the prose.
//
// SillyTavern already handles this on the native path — reasoning is parsed
// into `extra.reasoning` and `add_to_prompts` decides whether it comes back.
// Remodel's paced delivery does not go through that: it accumulates the raw
// provider stream itself, so a reasoning block arrives as ordinary text, lands
// in the accepted prose, and is sent back by Remodel's own history builder
// regardless of what the native setting says. This closes that path.
//
// Nothing happens unless a complete block is actually present. A model that
// never emits one, or emits a format this is not configured for, is untouched:
// no stripping, no rewriting, no difference in what it is sent.

import { power_user } from '../../../power-user.js';

export const DEFAULT_REASONING_PREFIX = '<think>';
export const DEFAULT_REASONING_SUFFIX = '</think>';

/**
 * The markers the owner already configured for native reasoning parsing. Read
 * rather than hardcoded, so a model using different delimiters is handled by
 * changing one setting instead of this file.
 */
export function getReasoningMarkers() {
    const configured = power_user?.reasoning || {};
    const prefix = String(configured.prefix || '').trim() || DEFAULT_REASONING_PREFIX;
    const suffix = String(configured.suffix || '').trim() || DEFAULT_REASONING_SUFFIX;
    return { prefix, suffix };
}

/**
 * Separate reasoning from prose.
 *
 * Only COMPLETE blocks are removed. An unclosed prefix means either a turn cut
 * off mid-thought or a piece of prose that happens to contain the marker, and
 * there is no way to tell them apart — so the conservative reading wins and the
 * text is returned untouched. Stripping from an unclosed marker to the end
 * would silently delete a whole reply in the second case.
 *
 * @returns {{found: boolean, prose: string, reasoning: string, blocks: number}}
 */
export function splitReasoning(source, markers = getReasoningMarkers()) {
    const text = String(source ?? '');
    const prefix = String(markers?.prefix || DEFAULT_REASONING_PREFIX);
    const suffix = String(markers?.suffix || DEFAULT_REASONING_SUFFIX);
    if (!text || !prefix || !suffix || !text.includes(prefix)) {
        return { found: false, prose: text, reasoning: '', blocks: 0 };
    }

    const reasoning = [];
    let prose = '';
    let cursor = 0;
    while (cursor < text.length) {
        const open = text.indexOf(prefix, cursor);
        if (open < 0) break;
        const close = text.indexOf(suffix, open + prefix.length);
        if (close < 0) break;
        reasoning.push(text.slice(open + prefix.length, close));
        prose += text.slice(cursor, open);
        cursor = close + suffix.length;
    }
    if (!reasoning.length) return { found: false, prose: text, reasoning: '', blocks: 0 };
    prose += text.slice(cursor);

    return {
        found: true,
        // A block usually sits at the very start, so removing it leaves the
        // prose beginning with the newline that followed it.
        prose: prose.replace(/^\s+/, '').replace(/\n{3,}/g, '\n\n'),
        reasoning: reasoning.join('\n\n').trim(),
        blocks: reasoning.length,
    };
}

/** The prose alone, for callers that have nowhere to put the reasoning. */
export function stripReasoning(source, markers = getReasoningMarkers()) {
    return splitReasoning(source, markers).prose;
}
