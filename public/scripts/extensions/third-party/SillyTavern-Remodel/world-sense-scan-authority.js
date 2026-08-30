// Who decides which lore the Narrator sees.
//
// Both lore paths otherwise activate entries by scanning raw text and matching
// keys, with no knowledge of World Sense at all:
//
//  - Roleplay hands core's scanner the action plus the last twelve messages
//    (live-direction.js), and core activates whatever those happen to name.
//  - Story runs its own scanner over the manuscript, prior text and beat
//    (story-world-info.js buildScanCorpus).
//
// World Sense's selection arrives separately — as WORLDINFO_FORCE_ACTIVATE in
// roleplay, and as forced keys that short-circuit key matching in Story. So the
// Narrator receives the union of "what World Sense chose" and "whatever the raw
// text happened to name", and the second half is nobody's decision.
//
// When World Sense owns activation, both scanners are handed an empty corpus.
// The selection is unaffected, because neither route depends on the scan text:
// core honours force-activation regardless, and the Story scanner admits forced
// keys before it ever consults the corpus. Constants are likewise untouched —
// they are an authoring decision, not a scan result.
//
// Both paths consult this one switch, so restoring stock behaviour is a single
// change in a single place, and a setting can drive it later without any call
// site being touched.
export const WORLD_SENSE_OWNS_ACTIVATION = true;

/**
 * The text a World Info scanner is allowed to match against.
 * @param {string[]} sources what the caller would have scanned
 * @returns {string[]} the same sources, or nothing when World Sense owns activation
 */
export function worldInfoScanCorpus(sources = []) {
    if (!WORLD_SENSE_OWNS_ACTIVATION) return sources;
    return [];
}

/**
 * Whether a scanner may recurse from the entries it has already activated.
 *
 * Emptying the corpus is not enough on its own. A constant entry activates
 * regardless of scan text, and native recursion then matches ITS content
 * against every key in the book — so one always-on entry silently pulls in its
 * whole neighbourhood by keyword, which is the activation being taken away.
 *
 * World Sense already walks the mention mesh and decides how far to go. Letting
 * the scanner walk it again, by different rules and with no budget, replaces
 * that decision with an unbounded one.
 *
 * @param {boolean} nativeSetting the user's own recursion preference
 */
export function worldInfoRecursionAllowed(nativeSetting) {
    if (!WORLD_SENSE_OWNS_ACTIVATION) return Boolean(nativeSetting);
    return false;
}
