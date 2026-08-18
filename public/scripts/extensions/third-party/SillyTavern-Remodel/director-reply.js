// Parse a Director's free-form reply into typed notebook entries plus the
// machine-readable state tail.
//
// PURE — no imports, so the exact parse can be asserted offline. The Director's
// reply is the only thing standing between the user and a scene, so every
// failure here degrades rather than throws: an unparseable tail costs the turn
// its state changes, never its prose.

export const ENTRY_TYPES = ['note', 'ruling', 'result', 'secret'];

/**
 * What a parsed entry may be STORED as. `unknown` is not a type the Director
 * is ever told about — it is where a line that looks like a tag but names
 * nothing we recognise ends up, kept for the owner and withheld from the
 * performer instead of silently joining the entry above it.
 */
export const STORED_ENTRY_TYPES = [...ENTRY_TYPES, 'unknown'];

/**
 * The only types the performer may ever see. An ALLOWLIST, deliberately.
 *
 * This was a denylist — everything except `secret` — and it failed open in the
 * one direction that cannot be undone. On the owner's turn 4 the Director
 * wrote three secrets as `Secret: …` rather than `[secret] …`; no tag matched,
 * the text joined the `note` above it, and all three went to the Narrator
 * under "treat as settled fact". That turn's entryTypes were
 * `[note, note, ruling, ruling, result]` — not one secret parsed, so the
 * filter had nothing to catch.
 *
 * A denylist can only withhold what it already knows to name. An allowlist
 * withholds whatever it does not positively recognise, which is the only shape
 * that survives a Director inventing a spelling.
 */
export const NARRATOR_VISIBLE_TYPES = ['note', 'ruling', 'result'];

/**
 * A tag is the type name in square brackets. Everything around it is noise the
 * model adds and we have to survive.
 *
 * The first version of this was `/^\[([a-z]+)\]\s?/i` — bare, line-leading. A
 * real Director wrote `- **[note]**` and `**[secret]**`, because it is writing
 * markdown and a bracketed label looks like something to emphasise. Nothing
 * matched, so an entire 1831-character reply parsed as ONE entry of type
 * `note` — and since `readNarratorEntries` withholds by type, both of that
 * turn's `[secret]` entries were handed to the Narrator as settled fact. The
 * secret type's whole value is that it never reaches the performer, and a
 * regex that only accepts one of the several ways a model writes a label is
 * not a foundation that guarantee can stand on.
 *
 * So: optional list marker, optional emphasis, optional trailing colon, and
 * matched ANYWHERE rather than only at a line start — a model that puts its
 * whole reply on one line must not collapse into a single untyped blob either.
 * Only the four known type names match, so an unrecognised tag is still
 * literal text and a typo still cannot invent a type nothing reads.
 */
const EMPHASIS = '(?:\\*{1,3}|_{1,3})';
const LIST = '(?:[-*+]\\s+|\\d+[.)]\\s+)?';
const KNOWN = 'note|ruling|result|secret';

/**
 * Three shapes, and the difference between them is how much prose each can
 * damage when it is wrong.
 *
 * 1. A KNOWN type in brackets, anywhere on a line. Widest, because it is
 *    unambiguous — nothing writes `[ruling]` mid-sentence by accident — and a
 *    Director that puts its whole reply on one line must still parse.
 * 2. A KNOWN type with no brackets, LINE-LEADING, followed by a colon or a
 *    dash: `Secret: …`, `Ruling — …`. THIS IS THE SHAPE THAT LEAKED: on the
 *    owner's turn 4 the Director wrote three secrets this way, no tag matched,
 *    the text joined the note above it and all three reached the Narrator.
 *    Restricted to line starts because "the secret: he lied" is prose, and
 *    treating that as a tag would cut a note in half.
 * 3. Anything else in brackets, LINE-LEADING only: `[foobar]`. Classified
 *    `unknown` and withheld from the performer. Line-leading only for the
 *    same reason — a stray `[sic]` inside a note must not split it and
 *    silently withhold the remainder, which is this fix failing in the
 *    opposite direction.
 */
const TAG = new RegExp([
    `(?:^|\\s)${LIST}${EMPHASIS}?\\[(${KNOWN})\\]${EMPHASIS}?:?[ \\t]*`,
    `^[ \\t]*${LIST}${EMPHASIS}?(${KNOWN})${EMPHASIS}?[ \\t]*[:—–-][ \\t]*`,
    `^[ \\t]*${LIST}${EMPHASIS}?\\[([A-Za-z][A-Za-z0-9 _'-]{0,40})\\]${EMPHASIS}?:?[ \\t]*`,
].join('|'), 'gim');
const STATE_FENCE = /```state\s*\n([\s\S]*?)\n?```/gi;

export function parseDirectorReply(text) {
    const raw = typeof text === 'string' ? text : '';
    const { body, tail, tailFound } = splitTail(raw);
    const { state, tailError } = readState(tail, tailFound);
    return { entries: readEntries(body), state, tailFound, tailError };
}

/**
 * Take the LAST state fence. A Director that discusses the format mid-reply —
 * quoting it, or reasoning about what it will write — must not have that read
 * as its answer.
 */
function splitTail(raw) {
    const matches = [...raw.matchAll(STATE_FENCE)];
    if (!matches.length) return { body: raw, tail: '', tailFound: false };
    const last = matches[matches.length - 1];
    const body = raw.slice(0, last.index) + raw.slice(last.index + last[0].length);
    return { body, tail: last[1], tailFound: true };
}

/** Flow defaults to stopping: a scene that runs away after a parse error is
 *  harder to notice, and harder to undo, than one that waits. */
function readState(tail, tailFound) {
    const empty = { requests: [], flow: { continue: false } };
    if (!tailFound) return { state: empty, tailError: '' };
    try {
        const parsed = JSON.parse(tail);
        return {
            state: {
                requests: Array.isArray(parsed?.requests) ? parsed.requests.filter((item) => item && typeof item === 'object') : [],
                flow: { continue: parsed?.flow?.continue === true },
            },
            tailError: '',
        };
    } catch (error) {
        return { state: empty, tailError: String(error?.message || error) };
    }
}

/**
 * Cut the body at every tag. An entry runs from its own tag to the next one,
 * so untagged prose after a tag continues that entry — which is what keeps a
 * `[secret]` that spills over several lines inside the secret. Untagged prose
 * BEFORE the first tag becomes a note rather than being discarded: losing the
 * Director's output to a missing tag would be the worst failure available.
 */
function readEntries(body) {
    const text = String(body);
    const matches = [...text.matchAll(TAG)];
    const entries = [];

    const leading = matches.length ? text.slice(0, matches[0].index) : text;
    if (leading.trim()) entries.push({ type: 'note', text: leading });

    matches.forEach((match, index) => {
        const start = match.index + match[0].length;
        const end = index + 1 < matches.length ? matches[index + 1].index : text.length;
        // Groups 1 and 2 are the two known-type shapes; group 3 is the
        // bracketed-but-unrecognised one. A word we do not know becomes
        // `unknown`, and `unknown` reaches nobody.
        const known = (match[1] || match[2] || '').toLowerCase();
        entries.push({ type: known || 'unknown', text: text.slice(start, end) });
    });

    return entries.map((entry) => ({ ...entry, text: tidy(entry.text) })).filter((entry) => entry.text);
}

/**
 * Trim, and drop the emphasis a model leaves dangling when it wraps a tag it
 * then forgets to close — `**[note]** text**` is one entry whose text is
 * `text`, not `text**`.
 */
function tidy(text) {
    return String(text).trim().replace(/^(?:\*{1,3}|_{1,3})|(?:\*{1,3}|_{1,3})$/g, '').trim();
}
