// Pulling prose out of a raw generation response — PURE, so it can be tested
// offline against real response shapes with no browser and no network.
//
// This exists because SillyTavern's own reader has a fall-through flaw on the
// Chat Completion branch. It reads text blocks out of `data.content` first, and
// when there are none that yields an EMPTY STRING — but its fallback chain uses
// `??`, which only falls through on null/undefined, never on ''. So a reply
// whose prose sits in `choices[0].message.content` is never read at all
// whenever a `content` array is present without a text block. Reasoning-only
// and tool-call-only replies do exactly that, which is why some models work and
// others mysteriously do not, and why Text Completion behaves better (its
// branch starts with a value that is `undefined` when absent, so its fallbacks
// actually fire).
//
// Every candidate below is checked with `||` semantics: an empty result always
// falls through to the next.

/**
 * @param {any} raw            the raw response object
 * @param {function} [coreExtract]  core's extractMessageFromData, tried LAST so
 *                                  its quirks can never mask a shape we handle
 * @returns {{ text, shape, source, reasoningOnly }}
 */
export function extractProse(raw, coreExtract = null) {
    const shape = describeShape(raw);

    if (typeof raw === 'string') {
        return { text: raw.trim(), shape, source: 'string', reasoningOnly: false };
    }
    if (!raw || typeof raw !== 'object') {
        return { text: '', shape, source: null, reasoningOnly: false };
    }

    const candidates = [
        ['content-text-blocks', () => blockText(raw.content, 'text')],
        ['choices[0].message.content', () => stringify(raw.choices?.[0]?.message?.content)],
        ['choices[0].text', () => stringify(raw.choices?.[0]?.text)],
        ['content-string', () => (typeof raw.content === 'string' ? raw.content : '')],
        ['text', () => stringify(raw.text)],
        ['response', () => stringify(raw.response)],
        ['message.content', () => stringify(raw.message?.content)],
        ['results[0].text', () => stringify(raw.results?.[0]?.text)],
        ['output', () => stringify(raw.output)],
        ['[0].content', () => stringify(raw[0]?.content)],
        ['core-extractor', () => stringify(coreExtract ? coreExtract(raw) : '')],
    ];

    for (const [source, read] of candidates) {
        let value = '';
        try {
            value = read();
        } catch {
            value = '';
        }
        if (value && value.trim()) {
            return { text: value.trim(), shape, source, reasoningOnly: false };
        }
    }

    // Nothing renderable. Note whether the model spent the turn thinking, since
    // that is a real and separately-fixable cause rather than a broken reply.
    const reasoning = blockText(raw.content, 'thinking')
        || blockText(raw.content, 'reasoning')
        || stringify(raw.choices?.[0]?.message?.reasoning)
        || stringify(raw.reasoning_content);
    return { text: '', shape, source: null, reasoningOnly: Boolean(reasoning && reasoning.trim()) };
}

/** True when a compiled prompt actually carries something to send. */
export function hasPromptContent(prompt) {
    if (typeof prompt === 'string') {
        return Boolean(prompt.trim());
    }
    if (!Array.isArray(prompt) || !prompt.length) {
        return false;
    }
    return prompt.some((message) => String(message?.content || '').trim());
}

/** A compact description of what came back, for the error message. */
export function describeShape(raw) {
    if (raw == null) {
        return 'no response object';
    }
    if (typeof raw === 'string') {
        return `string (${raw.length} chars)`;
    }
    if (typeof raw !== 'object') {
        return typeof raw;
    }
    const keys = Object.keys(raw).slice(0, 8).join(', ');
    const contentKind = Array.isArray(raw.content)
        ? `content[${raw.content.map((part) => part?.type || '?').join('/')}]`
        : typeof raw.content === 'string' ? 'content:string' : '';
    return [keys && `keys: ${keys}`, contentKind].filter(Boolean).join(' · ') || 'empty object';
}

function blockText(content, type) {
    if (!Array.isArray(content)) {
        return '';
    }
    return content
        .filter((part) => part?.type === type)
        .map((part) => part?.text ?? part?.thinking ?? part?.reasoning ?? '')
        .filter(Boolean)
        .join('\n\n');
}

function stringify(value) {
    if (typeof value === 'string') {
        return value;
    }
    if (Array.isArray(value)) {
        return value.map((part) => (typeof part === 'string' ? part : part?.text ?? '')).filter(Boolean).join('\n\n');
    }
    return '';
}
