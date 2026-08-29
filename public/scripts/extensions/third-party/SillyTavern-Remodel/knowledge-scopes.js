// Author and actor knowledge, projected explicitly.
//
// The Narrator may hold author-level secrets so it can build dramatic irony and
// causal behaviour. An actor may not. Today a secret is a flat {key, value}
// with no notion of who knows it, so "the Narrator knows" and "the character
// knows" are the same fact — which is exactly how a character ends up speaking
// from something it was never told.
//
// This module is a PROJECTION only. It does not store lore, does not render
// prompts, and cannot grant knowledge: a stance the Timeline Web has not
// explicitly recorded is `unknown`, never inferred. Rendering lives behind one
// prompt adapter so a leak has a single place to happen and a single place to
// be tested.

/** What an actor may hold about a secret. Absent means `unknown`. */
export const KNOWLEDGE_STANCES = Object.freeze(['knows', 'suspects', 'unknown']);

/**
 * What the author may DO with a secret, which is a separate question from who
 * knows it. A secret can be fully known to the author and still be unusable as
 * anything but hidden causality.
 */
export const DISCLOSURE_MODES = Object.freeze(['revealable', 'foreshadowable', 'causal-only']);

const DEFAULT_DISCLOSURE = 'causal-only';

/**
 * Normalize one recorded scope. The defaults are deliberately the restrictive
 * ones: an unrecognized stance collapses to `unknown` and an unrecognized
 * disclosure to `causal-only`, so a malformed record silently narrows what may
 * be said rather than silently widening it.
 */
export function normalizeKnowledgeScope(value = {}) {
    const actors = {};
    for (const [actorId, stance] of Object.entries(value?.actors || {})) {
        const id = String(actorId || '').trim();
        if (!id) continue;
        actors[id] = KNOWLEDGE_STANCES.includes(stance) ? stance : 'unknown';
    }
    return Object.freeze({
        key: String(value?.key || ''),
        authorKnows: value?.authorKnows !== false,
        actors: Object.freeze(actors),
        disclosure: DISCLOSURE_MODES.includes(value?.disclosure) ? value.disclosure : DEFAULT_DISCLOSURE,
    });
}

/** An actor's stance on one secret. Only explicit state grants anything. */
export function actorStance(scope, actor) {
    const id = String(actor || '').trim();
    if (!id) return 'unknown';
    return normalizeKnowledgeScope(scope).actors[id] || 'unknown';
}

/**
 * What this actor may speak, reason, or act from.
 *
 * `knows` carries the value. `suspects` carries the key and nothing else — an
 * actor may act on a suspicion without being able to state the fact. `unknown`
 * yields nothing at all: not the value, not the key, not its existence.
 */
export function projectActorKnowledge({ secrets = [], scopes = [], actor } = {}) {
    const byKey = new Map(scopes.map((scope) => [String(scope?.key || ''), normalizeKnowledgeScope(scope)]));
    const items = [];
    for (const secret of secrets) {
        const key = String(secret?.key || '');
        const stance = actorStance(byKey.get(key), actor);
        if (stance === 'knows') items.push(Object.freeze({ key, stance, value: secret?.value }));
        else if (stance === 'suspects') items.push(Object.freeze({ key, stance, value: null }));
    }
    return Object.freeze({ actor: String(actor || ''), items: Object.freeze(items) });
}

/**
 * The author-level view. Everything the author knows, each item labelled with
 * what may be done with it and who else holds it, so the Narrator can build
 * irony without handing the fact to a character who lacks it.
 */
export function projectAuthorKnowledge({ secrets = [], scopes = [] } = {}) {
    const byKey = new Map(scopes.map((scope) => [String(scope?.key || ''), normalizeKnowledgeScope(scope)]));
    const items = secrets
        .filter((secret) => (byKey.get(String(secret?.key || '')) || normalizeKnowledgeScope({})).authorKnows)
        .map((secret) => {
            const scope = byKey.get(String(secret?.key || '')) || normalizeKnowledgeScope({});
            const stances = { knows: [], suspects: [] };
            for (const [actorId, stance] of Object.entries(scope.actors)) {
                if (stance === 'knows' || stance === 'suspects') stances[stance].push(actorId);
            }
            return Object.freeze({
                key: String(secret?.key || ''),
                value: secret?.value,
                disclosure: scope.disclosure,
                knownBy: Object.freeze(stances.knows.sort()),
                suspectedBy: Object.freeze(stances.suspects.sort()),
            });
        });
    return Object.freeze({ items: Object.freeze(items) });
}

/**
 * The single prompt adapter. Every path that puts knowledge in front of a model
 * goes through here, so "did this leak?" is one question about one function
 * rather than a question about every caller.
 *
 * @param {'author'|'actor'} audience
 */
export function renderKnowledgeSection(projection, audience) {
    if (audience === 'actor') {
        if (!projection?.items?.length) return '';
        const lines = projection.items.map((item) => (item.stance === 'knows'
            ? `- ${item.key}: ${item.value}`
            : `- ${item.key}: suspected, not established`));
        return [`[WHAT ${String(projection.actor || 'THIS ACTOR').toUpperCase()} KNOWS]`, ...lines].join('\n');
    }
    if (!projection?.items?.length) return '';
    const lines = projection.items.map((item) => {
        const held = item.knownBy.length ? ` · known by ${item.knownBy.join(', ')}` : '';
        const guessed = item.suspectedBy.length ? ` · suspected by ${item.suspectedBy.join(', ')}` : '';
        return `- ${item.key} [${item.disclosure}]${held}${guessed}: ${item.value}`;
    });
    return ['[AUTHOR KNOWLEDGE — not every item may be stated aloud]', ...lines].join('\n');
}

/**
 * A guard for the paths that must never see author-only material: retrieval,
 * background ingestion, and anything rendered as a character's own reasoning.
 * Returns the keys that would leak, so a caller can fail closed and say which.
 */
export function findKnowledgeLeaks(text, { secrets = [], scopes = [], actor } = {}) {
    const permitted = new Set(projectActorKnowledge({ secrets, scopes, actor }).items
        .filter((item) => item.stance === 'knows')
        .map((item) => String(item.value ?? '')));
    const haystack = String(text || '');
    return Object.freeze(secrets
        .map((secret) => String(secret?.value ?? ''))
        .filter((value) => value && !permitted.has(value) && haystack.includes(value)));
}
