// Pacing beats, derived from finished prose.
//
// The Narrator used to be told to type [[RM:BREATH]] itself, which made the
// scene's rhythm depend on a creative model emitting machine tokens well in a
// format whose effect it could not observe. Reading the text afterwards is
// deterministic, costs the model nothing, and can be tuned without re-prompting.
//
// PURE — no context, no DOM — so it is testable offline.

/** Abbreviations whose full stop does not end a sentence. */
const ABBREVIATIONS = new Set(['mr', 'mrs', 'ms', 'dr', 'st', 'sgt', 'lt', 'prof', 'vs', 'etc', 'no']);

/** Closing punctuation that a beat should sit after: quotes and brackets. */
const TRAILING = new Set(['"', "'", '”', '’', ')', ']', '»']);

/**
 * @param {string} source finished prose, markers already stripped
 * @returns {Array<{offset: number, kind: 'breath'|'opening'}>}
 */
export function deriveBeats(source) {
    const text = String(source ?? '');
    if (!text.trim()) return [];
    const beats = [];
    const seen = new Set();
    const push = (offset, kind) => {
        const at = Math.min(Math.max(0, offset), text.length);
        if (seen.has(at)) return;
        seen.add(at);
        beats.push({ offset: at, kind });
    };

    // Paragraph breaks are the strongest boundary the prose offers, so they
    // become openings — the moments where stepping in reads as natural.
    for (const match of text.matchAll(/\n[ \t]*\n/g)) {
        push(match.index, 'opening');
    }

    for (let index = 0; index < text.length; index++) {
        const character = text[index];
        if (character !== '.' && character !== '!' && character !== '?') continue;
        // Consume a run so "..." and "?!" are one beat rather than three.
        let end = index;
        while (end + 1 < text.length && '.!?'.includes(text[end + 1])) end++;
        if (isAbbreviation(text, index)) { index = end; continue; }
        // Carry past a closing quote or bracket so the beat lands after it.
        while (end + 1 < text.length && TRAILING.has(text[end + 1])) end++;
        // Skip spaces to position the beat at the next word.
        while (end + 1 < text.length && text[end + 1] === ' ') end++;
        push(end + 1, 'breath');
        index = end;
    }

    return beats.sort((left, right) => left.offset - right.offset);
}

/** True when the full stop at `index` closes a known abbreviation. */
function isAbbreviation(text, index) {
    if (text[index] !== '.') return false;
    let start = index - 1;
    while (start >= 0 && /[A-Za-z]/.test(text[start])) start--;
    const word = text.slice(start + 1, index).toLowerCase();
    return word.length > 0 && ABBREVIATIONS.has(word);
}
