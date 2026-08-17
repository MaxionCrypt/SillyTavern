// Parse a Director's free-form reply into typed notebook entries plus the
// machine-readable state tail.
//
// PURE — no imports, so the exact parse can be asserted offline. The Director's
// reply is the only thing standing between the user and a scene, so every
// failure here degrades rather than throws: an unparseable tail costs the turn
// its state changes, never its prose.

export const ENTRY_TYPES = ['note', 'ruling', 'result', 'secret'];

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
const TAG = new RegExp(
    `(?:^|\\s)(?:[-*+]\\s+|\\d+[.)]\\s+)?${EMPHASIS}?\\[(note|ruling|result|secret)\\]${EMPHASIS}?:?[ \\t]*`,
    'gi',
);
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
        entries.push({ type: match[1].toLowerCase(), text: text.slice(start, end) });
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
