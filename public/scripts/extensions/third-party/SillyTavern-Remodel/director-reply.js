// Parse a Director's free-form reply into typed notebook entries plus the
// machine-readable state tail.
//
// PURE — no imports, so the exact parse can be asserted offline. The Director's
// reply is the only thing standing between the user and a scene, so every
// failure here degrades rather than throws: an unparseable tail costs the turn
// its state changes, never its prose.

export const ENTRY_TYPES = ['note', 'ruling', 'result', 'secret'];

const TAG = /^\[([a-z]+)\]\s?/i;
const STATE_FENCE = /```state\s*\n([\s\S]*?)\n?```/gi;

export function parseDirectorReply(text) {
    const raw = String(text || '');
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
 * Split on line-leading tags. An unrecognised tag is literal text, not a new
 * entry: a typo must never silently create a type nothing reads. Untagged
 * leading prose becomes a note rather than being discarded — losing the
 * Director's output to a missing tag would be the worst failure available.
 */
function readEntries(body) {
    const entries = [];
    for (const line of String(body).split('\n')) {
        const match = line.match(TAG);
        const type = match && ENTRY_TYPES.includes(match[1].toLowerCase()) ? match[1].toLowerCase() : '';
        if (type) entries.push({ type, text: line.slice(match[0].length) });
        else if (entries.length) entries[entries.length - 1].text += `\n${line}`;
        else if (line.trim()) entries.push({ type: 'note', text: line });
    }
    return entries.map((entry) => ({ ...entry, text: entry.text.trim() })).filter((entry) => entry.text);
}
