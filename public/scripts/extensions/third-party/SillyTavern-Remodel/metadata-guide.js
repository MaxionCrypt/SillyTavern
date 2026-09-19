// Exactly what a model has to put down.
//
// Prose is the only part of a reply that arrives on its own. Every other effect
// — a lore edit, a lore keyword pull, a swap — happens because a model emitted a
// specific shape and code recognised it. Get a shape wrong and the prose still
// commits while the effect silently never happens, so this is a paste reference:
// every op carries the exact line that runs it.
//
// Pure: data only, no DOM, no store, no network. The Debug Console renders it.

import { MAX_LORE_KEYWORDS, MAX_LORE_KEYWORD_GROUPS, MAX_LORE_OPS } from './loom-reconciliation.js';

export function buildMetadataGuide() {
    return Object.freeze({
        fence: fence(),
        envelope: envelope(),
        lore: lore(),
    });
}

// --- The fence --------------------------------------------------------------

function fence() {
    return Object.freeze({
        opener: '```state',
        example: [
            '```state',
            '{"swaps":[],"loreKeywords":[],"loreOps":[',
            '  {"id":"o1","op":"lore.edit","arguments":{"book":"TL","uid":"1","content":"..."},"reason":"the accepted prose changed this fact"}',
            '],"flow":{"continue":false}}',
            '```',
        ].join('\n'),
    });
}

// --- Top-level keys ---------------------------------------------------------

function envelope() {
    return Object.freeze([
        key('swaps', 'array', 'Patch contract only, and only applied when the reply carries no prose.',
            '"swaps":[{"find":"exact text from the draft","replace":"what it becomes"}]'),
        key('loreKeywords', 'array', 'Keyword groups that REPLACE this scene\'s working lore. Empty keeps the current set.',
            '"loreKeywords":[["Queens Lake University"],["event","Marissa"]]'),
        key('loreOps', 'array', 'Typed edits/creations against Living Lore entries. Empty unless accepted fiction changed a scoped entry or established a new durable subject.',
            '"loreOps":[{"id":"o1","op":"lore.edit","arguments":{"book":"TL","uid":"1","content":"..."},"reason":"why"}]'),
        key('flow', 'object', 'Whether the turn continues. Absent means neither.',
            '"flow":{"continue":false,"hardPause":false}'),
    ]);
}

function key(name, type, purpose, example) {
    return Object.freeze({ name, type, purpose, example });
}

// --- Living Lore ------------------------------------------------------------

function lore() {
    return Object.freeze({
        ops: Object.freeze({
            example: JSON.stringify({
                loreOps: [
                    { id: 'o1', op: 'lore.edit', arguments: { book: 'TL', uid: '1', content: 'The lighthouse has run unmanned on a timer since the keeper died.' }, reason: 'the keeper is confirmed dead' },
                    { id: 'o2', op: 'lore.create', arguments: { name: 'Queens Lake Lighthouse', keys: ['Queens Lake Lighthouse', 'the lighthouse'], content: 'A coastal light north of the town, automated.' }, reason: 'a new durable place' },
                ],
            }),
            arguments: Object.freeze([
                field('op', 'string', true, 'Either "lore.edit" (rewrite an entry already in the Selected Living Lore) or "lore.create" (add a new entry to the timeline book).'),
                field('book', 'string', false, 'lore.edit only: the entry\'s book, exactly as the Selected Living Lore names it.'),
                field('uid', 'string', false, 'lore.edit only: the entry\'s uid within that book.'),
                field('name', 'string', false, 'lore.create only: a short title for the new entry.'),
                field('keys', 'array of strings', false, 'lore.create only: the exact trigger keywords the new entry answers to.'),
                field('content', 'string', true, 'The full entry text after the change. Capped; longer content is truncated, not rejected.'),
                field('secret', 'boolean', false, 'true hides the entry from the Narrator (Loom-only); false reveals a hidden entry. Omit to leave visibility unchanged.'),
            ]),
            note: `Up to ${MAX_LORE_OPS} ops per turn. Edit only an entry that is in the Selected Living Lore; to change one that is not, first name its key in loreKeywords to pull it in. A lore.edit whose book/uid is not in scope is refused.`,
        }),
        keywords: Object.freeze({
            example: JSON.stringify({ loreKeywords: [['Queens Lake University'], ['event', 'Marissa']] }),
            arguments: Object.freeze([
                field('loreKeywords', 'array of keyword groups', false, `Up to ${MAX_LORE_KEYWORD_GROUPS} groups of up to ${MAX_LORE_KEYWORDS} keys each. Must be the exact key an entry answers to — "Queens" will not find "Queens Lake University". An entry needing several keys is pulled only when they are named together in one group.`),
            ]),
            note: 'A non-empty loreKeywords REPLACES the scene\'s working set with exactly these groups; leave it empty to keep the current set. Include everything the coming turns need, not just what is new.',
        }),
    });
}

function field(key, type, required, hint, values = []) {
    return Object.freeze({ key, type, required, values: Object.freeze([...values]), hint });
}
