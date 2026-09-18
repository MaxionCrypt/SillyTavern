
// The "rewrite everything" contract is retired. The Loom no longer re-emits the
// whole turn: it names only the spans a ruling changed. The PATCH contract
// below is the only one seeded, built, or produced. See parseLoomReply, which
// still reads prose if an owner-authored legacy recipe returns any — that read
// path stays so an ancient recipe keeps working, but nothing here writes the
// prose-first contract any more.

// --- The PATCH contract -----------------------------------------------------
//
// WHY IT EXISTS: under the default contract the Loom must re-emit the ENTIRE
// turn before it may write its state fence. Measured on the owner's session
// that cost 17-94 seconds per turn, on top of the Narrator's own 28-47 - the
// Loom was re-typing prose that already existed.
//
// The draft is already canonical here: applySwaps() patches it in code, and a
// reply with no swaps leaves it untouched. So the Loom only has to name the
// spans a ruling actually changes, which on most turns is none of them - a few
// hundred characters instead of a few thousand.
const SUPERSEDED_PATCH_POLICY_FINGERPRINTS = Object.freeze(new Set([
    '1132:31eaf52a',
    '1469:6933aef9',
    '1747:83c9ce7a',
    '1805:07fdd12d',
    // v21: consequences were explicit, but Living Lore remained only an
    // optional macro contract and was never part of the Loom's checklist.
    '2021:d78a1111',
]));

function policyFingerprint(value) {
    const text = String(value || '');
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return `${text.length}:${hash.toString(16).padStart(8, '0')}`;
}

export function isSupersededLoomPatchPolicy(value) {
    return SUPERSEDED_PATCH_POLICY_FINGERPRINTS.has(policyFingerprint(value));
}

export const LOOM_POLICY_PATCH = `You are the Loom: the final continuity editor and mechanical referee. You receive the Narrator's draft before anything becomes visible. The draft is already canonical - do NOT rewrite or reproduce it.

STEP 1 - Consequences. Goals describe outcomes their holders are trying to achieve, never outcomes the story must protect. Ask what materially changed because this turn happened. A Goal's description guides measurement but is not an exhaustive whitelist: if new fiction reveals that its condition is incomplete, refine the description with goal.edit rather than declaring the action irrelevant. When the fiction helps or obstructs an open Goal, use goal.edit to set its Success Rate to the holder's new chance of achieving it, even when no roll is needed. Small pressure may move it a few points; a meaningful reversal should move it substantially. Close a Goal with goal.edit when it becomes achieved, abandoned, or impossible. Use goal.create only when the fiction establishes a meaningful unresolved outcome worth tracking, never merely because a named character lacks one. Use goal.reach only for a decisive attempt whose outcome is genuinely uncertain; routine or already-established consequences need no roll. Code rolls the dice, never you.
STEP 2 - Patch. If, and ONLY if, continuity or an authorized roll contradicts the draft, name the exact span to replace. Quote the draft verbatim in "find". Most turns need no patch at all.
STEP 3 - Living Lore. The Selected Living Lore is the set of entries in scope this scene. If accepted fiction changed a fact in one of them, rewrite that entry with a lore.edit op naming its book and uid. If the fiction established a meaningfully reusable new subject that no entry yet covers - a person, place, group, institution, stable relationship, discovered rule, persistent condition, or durable open thread - add it with a lore.create op. You may only edit an entry that is in the Selected Living Lore; to change one that is not, first name its key in loreKeywords to pull it in. Do not record transient actions, momentary moods or positions, scene summaries, or decorative details. Most turns change nothing - leave loreOps empty then.`;

const LOOM_OUTPUT_CONTRACT_PATCH_V21 = `Output NOTHING except one state fence. Do not restate the prose.
\`\`\`state
{"swaps":[],"requests":[{"id":"r1","capability":"event.record","arguments":{"summary":"what happened"},"reason":"why, one line"},{"id":"r2","capability":"goal.edit","arguments":{"goalRef":"the exact Goal name","successRate":23},"reason":"how this turn changed its holder's position"},{"id":"r3","capability":"beat.set","arguments":{"directive":"the unresolved thread after this turn"},"reason":"why, one line"}],"loreProposals":[],"flow":{"continue":false}}
\`\`\`

Every request is its own object. Close one with } and open the next with {, exactly as above. Never repeat "id" inside a single object.

Each swap is {"find":"exact text from the draft","replace":"what it becomes"}. A find that is not present verbatim in the draft is discarded, so copy it exactly.`;

export const LOOM_OUTPUT_CONTRACT_PATCH_PRE_LORE = LOOM_OUTPUT_CONTRACT_PATCH_V21
    .replace('],"loreProposals":[],"flow"', '],"flow"');

/** The contract that shipped between durable-lore cultivation and the World
 * Sense promotion receipt. It advertises loreProposals but predates
 * lorePromotionDecisions, so a store seeded in that window hands the Loom
 * promotion candidates it has no contracted way to answer. Frozen as a literal
 * on purpose: deriving it from the current contract would silently rot the
 * moment that contract is edited again. */
export const LOOM_OUTPUT_CONTRACT_PATCH_PRE_PROMOTION = `Output NOTHING except one state fence. Do not restate the prose.
\`\`\`state
{"swaps":[],"requests":[{"id":"r1","capability":"event.record","arguments":{"summary":"what happened"},"reason":"why, one line"},{"id":"r2","capability":"goal.edit","arguments":{"goalRef":"the exact Goal name","successRate":23},"reason":"how this turn changed its holder's position"},{"id":"r3","capability":"beat.set","arguments":{"directive":"the unresolved thread after this turn"},"reason":"why, one line"}],"loreProposals":[],"flow":{"continue":false}}
\`\`\`

Every request is its own object. Close one with } and open the next with {, exactly as above. Never repeat "id" inside a single object.

Always include the top-level loreProposals array. Leave it empty when the Durable Lore Check finds no warranted change; otherwise follow the Selected Living Lore proposal shape exactly.

Each swap is {"find":"exact text from the draft","replace":"what it becomes"}. A find that is not present verbatim in the draft is discarded, so copy it exactly.`;

export function isSupersededLoomPatchContract(value) {
    return value === LOOM_OUTPUT_CONTRACT_PATCH_V21
        || value === LOOM_OUTPUT_CONTRACT_PATCH_PRE_LORE
        || value === LOOM_OUTPUT_CONTRACT_PATCH_PRE_PROMOTION
        // The compact v15 contract persisted in stores seeded before the
        // expanded goal examples were introduced.
        || policyFingerprint(value) === '397:3fa9c0d4';
}

export const LOOM_OUTPUT_CONTRACT_PATCH = `Output NOTHING except one state fence. Do not restate the prose.
\`\`\`state
{"swaps":[],"requests":[{"id":"r1","capability":"goal.edit","arguments":{"goalRef":"the exact Goal name","successRate":23},"reason":"how this turn changed its holder's position"}],"loreKeywords":[],"loreOps":[],"flow":{"continue":false}}
\`\`\`

Every request is its own object. Close one with } and open the next with {, exactly as above. Never repeat "id" inside a single object.

Always include the top-level loreOps array. Leave it empty unless accepted fiction changed a Selected Living Lore entry (a lore.edit op naming its book and uid) or established a new durable subject (a lore.create op giving name, keys, and content).

Each swap is {"find":"exact text from the draft","replace":"what it becomes"}. A find that is not present verbatim in the draft is discarded, so copy it exactly.`;

/** True when a scene uses the Narrator draft -> Loom reconciliation pipeline. */
export function usesLoomReconciliation(scene) {
    return scene?.liveDirection?.mode === 'loom';
}

/** Dynamic context blocks available to every Loom recipe. */
export function buildLoomRecipeSources({ draft, draftReasoning = '', playerAction = '', narrativeState = '', mechanicsSkill = '', livingLore = '' }) {
    return {
        playerAction: String(playerAction || '').trim()
            ? [
                'CURRENT PLAYER ACTION — AUTHORITATIVE TURN INPUT',
                'This is the player\'s explicit speech, voluntary action, or attempted action for this turn. It outranks conflicting inference in the Narrator draft. Preserve what the player explicitly said or attempted, judge only uncertain outcomes and world reactions, and never invent additional voluntary player speech, thoughts, decisions, or actions.',
                String(playerAction).trim(),
            ].join('\n')
            : '',
        archiveState: String(narrativeState || '').trim()
            ? `Current Archive, Goals, and open thread:\n${String(narrativeState).trim()}`
            : '',
        mechanicsBoard: String(mechanicsSkill || '').trim()
            ? `Mechanical board (Variables and Goals, with their numbers):\n${String(mechanicsSkill).trim()}`
            : '',
        livingLore: String(livingLore || '').trim(),
        narratorDraft: `The Narrator's private draft of this turn. Return its complete final version before the state fence:\n${String(draft || '')}`,
        narratorReasoning: String(draftReasoning || '').trim()
            ? `The Narrator's private reasoning:\n${String(draftReasoning).trim()}`
            : '',
    };
}

/**
 * The built-in Loom prompt, used only as the safety net when a scene has no
 * compiled Loom recipe to send. It is the PATCH contract: the Narrator's draft
 * is already canonical, and the Loom names only the spans a ruling changes plus
 * its state fence. It never asks the model to re-type the turn.
 *
 * @param {{draft: string, draftReasoning?: string, narrativeState?: string, mechanicsSkill?: string, livingLore?: string}} input
 * @returns {{role: string, content: string}[]}
 */
export function buildLoomPrompt({ draft, draftReasoning = '', playerAction = '', narrativeState = '', mechanicsSkill = '', livingLore = '' }) {
    const sources = buildLoomRecipeSources({ draft, draftReasoning, playerAction, narrativeState, mechanicsSkill, livingLore });
    const system = [LOOM_POLICY_PATCH, sources.archiveState, sources.mechanicsBoard, sources.livingLore, LOOM_OUTPUT_CONTRACT_PATCH].filter(Boolean).join('\n\n');
    const user = [sources.playerAction, sources.narratorDraft, sources.narratorReasoning].filter(Boolean).join('\n\n');
    return [
        { role: 'system', content: system },
        { role: 'user', content: user },
    ];
}

const STATE_FENCE = /```state\s*\n([\s\S]*?)\n?```/i;
const STATE_FENCE_START = /(?:^|\n)```state\b/i;
const WHOLE_JSON_FENCE = /^\s*```(?:json)?\s*\n([\s\S]*?)\n?```\s*$/i;

/** Providers occasionally preserve the JSON but rename ```state to ```json
 * (or drop the fence altogether). Recover only when the WHOLE reply is a
 * Loom-shaped action envelope. This must never fish JSON out of scene prose. */
function readLoomEnvelope(text) {
    const stateMatch = String(text || '').match(STATE_FENCE);
    if (stateMatch) {
        try {
            return { present: true, parsed: true, format: 'state', json: stateMatch[1], value: JSON.parse(stateMatch[1]) };
        } catch {
            const quotedRepair = repairQuotedRequestObjects(stateMatch[1]);
            const repaired = repairExtraArrayObjectCloser(quotedRepair);
            if (repaired !== stateMatch[1]) {
                try {
                    const value = JSON.parse(repaired);
                    if (isLoomEnvelope(value)) {
                        const format = repaired !== quotedRepair
                            ? 'state-extra-closer-repaired'
                            : 'state-quoted-object-repaired';
                        return { present: true, parsed: true, format, json: repaired, value };
                    }
                } catch { /* a bounded repair did not make the whole envelope valid */ }
            }
            return { present: true, parsed: false, format: 'state', json: stateMatch[1], value: null };
        }
    }

    const source = String(text || '');
    const jsonFence = source.match(WHOLE_JSON_FENCE);
    const candidate = jsonFence ? jsonFence[1] : source.trim();
    if (!candidate.startsWith('{') || !candidate.endsWith('}')) {
        return { present: false, parsed: false, format: '', json: '', value: null };
    }
    try {
        const value = JSON.parse(candidate);
        if (!isLoomEnvelope(value)) return { present: false, parsed: false, format: '', json: '', value: null };
        return {
            present: true,
            parsed: true,
            format: jsonFence ? 'json-fence-recovered' : 'bare-json-recovered',
            json: candidate,
            value,
        };
    } catch {
        return { present: false, parsed: false, format: '', json: '', value: null };
    }
}

function isLoomEnvelope(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        && (Array.isArray(value.requests) || Array.isArray(value.swaps)
            || Array.isArray(value.loreOps) || Array.isArray(value.lorePromotionDecisions)
            || (value.flow && typeof value.flow === 'object' && !Array.isArray(value.flow)));
}

/**
 * Some models emit the next request object as `,"{"id":...` instead of
 * `,{"id":...`. Repair only that exact array-boundary defect. This is not a
 * general JSON fixer: it cannot invent braces, commas, fields, or values, and
 * the repaired result still has to parse as a complete Loom envelope.
 */
function repairQuotedRequestObjects(json) {
    return String(json || '').replace(/([,\[]\s*)"\s*(\{\s*"id"\s*:)/g, '$1$2');
}

/**
 * Some structured-output providers close a request twice before the next
 * array item: `..."reason":"why"}}, {"id":...`. Remove only a closing brace
 * that cannot match the current JSON stack, occurs while the parser is inside
 * an array, and is immediately followed by that array's comma or terminator.
 *
 * This is deliberately narrower than a general JSON repair. It never invents
 * structure, edits strings or values, or guesses where a missing token belongs;
 * the complete repaired envelope still has to pass JSON.parse and the Loom
 * envelope shape check.
 */
function repairExtraArrayObjectCloser(json) {
    const source = String(json || '');
    const stack = [];
    let output = '';
    let inString = false;
    let escaped = false;
    let changed = false;
    for (let index = 0; index < source.length; index += 1) {
        const char = source[index];
        if (inString) {
            output += char;
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === '"') inString = false;
            continue;
        }
        if (char === '"') {
            inString = true;
            output += char;
            continue;
        }
        if (char === '{') stack.push('}');
        else if (char === '[') stack.push(']');
        else if (char === '}' || char === ']') {
            if (stack.at(-1) === char) stack.pop();
            else {
                const next = source.slice(index + 1).match(/\S/)?.[0] || '';
                if (char === '}' && stack.at(-1) === ']' && (next === ',' || next === ']')) {
                    changed = true;
                    continue;
                }
                return source;
            }
        }
        output += char;
    }
    return changed ? output : source;
}

/** Return only the prose portion of a cumulative Loom response. While the
 * response is still streaming, withhold a partial state-fence opener so its
 * backticks can never flash into the roleplay manuscript. */
export function readLoomProse(raw, { final = false } = {}) {
    const text = String(raw ?? '');
    const match = STATE_FENCE_START.exec(text);
    let prose = match ? text.slice(0, match.index) : text;
    if (!match && final && readLoomEnvelope(text).parsed) prose = '';
    // A patch-contract response contains no visible prose. Withhold leading
    // JSON while it streams so a provider's altered fence cannot flash its
    // internal requests into the manuscript before the final parse recovers it.
    if (!match && !final && /^\s*(?:```(?:json)?\s*(?:\n|$)|\{)/i.test(text)) prose = '';
    if (!match && !final) {
        const partialFence = prose.match(/\n?`{1,3}(?:s(?:t(?:a(?:t(?:e)?)?)?)?)?$/i);
        if (partialFence) prose = prose.slice(0, -partialFence[0].length);
    }
    prose = prose.replace(/^\s+/, '');
    return final ? prose.trimEnd() : prose;
}


/**
 * Parse the Loom's reply: the complete final prose, followed by a single
 * ```state fence whose JSON carries the mechanics requests to execute and
 * the flow decision. The returned prose is what the caller commits.
 * Owner-authored recipes still on the older preserve-and-patch contract instead
 * return swaps (find/replace spans against the draft); those apply only when
 * the model returned no prose at all. A missing or malformed fence is not an
 * error: no prose changes, no requests.
 *
 * @param {string} raw
 * @returns {{ prose: string, swaps: {find: string, replace: string}[], requests: object[], flow: {continueAfter: boolean, hardPauseAfter: boolean}|null, loreKeywords: string[][], loreOps: object[] }}
 */
/**
 * Keywords the Loom asked to retrieve on. Bounded: a request naming half the
 * book is not a request, it is pulling everything in wearing a different name.
 */
export const MAX_LORE_KEYWORD_GROUPS = 8;
export const MAX_LORE_KEYWORDS = 8;
export const MAX_LORE_KEYWORD_CHARS = 120;

// loreKeywords is a list of GROUPS: each group is an array of exact keys, and
// an entry that needs several keys (a native selective entry) is only pulled
// when they are named together in one group. Flat string arrays are no longer
// valid — they collapse to nothing rather than silently becoming one group.
export function readLoreKeywords(value) {
    if (!Array.isArray(value)) return [];
    const groups = [];
    for (const group of value) {
        if (!Array.isArray(group)) continue;
        const keywords = [...new Set(group
            .map((word) => String(word ?? '').trim())
            .filter(Boolean)
            .map((word) => word.slice(0, MAX_LORE_KEYWORD_CHARS)))].slice(0, MAX_LORE_KEYWORDS);
        if (keywords.length) groups.push(keywords);
        if (groups.length >= MAX_LORE_KEYWORD_GROUPS) break;
    }
    return groups;
}

export const MAX_LORE_OPS = 16;
const MAX_LORE_OP_CONTENT_CHARS = 12000;
const LORE_OP_NAMES = new Set(['lore.edit', 'lore.create']);

// Typed lore operations: lore.edit (rewrite a cached entry) and lore.create (a
// new entry). Reads args off the fence's nested `arguments` object (or a flat
// op, for lenient recovery), normalizes to a flat op, and drops anything
// malformed or of an unknown kind.
export function readLoreOps(value) {
    if (!Array.isArray(value)) return [];
    const out = [];
    for (const entry of value) {
        if (!entry || typeof entry !== 'object') continue;
        const op = String(entry.op ?? '').trim();
        if (!LORE_OP_NAMES.has(op)) continue;
        const args = entry.arguments && typeof entry.arguments === 'object' ? entry.arguments : entry;
        const content = String(args.content ?? '').slice(0, MAX_LORE_OP_CONTENT_CHARS);
        // Optional visibility change: true hides, false reveals; anything else
        // (null/absent) leaves the entry's secrecy untouched.
        const secret = args.secret === true ? { secret: true } : args.secret === false ? { secret: false } : {};
        if (op === 'lore.edit') {
            const book = String(args.book ?? '').trim();
            const uid = String(args.uid ?? '').trim();
            if (!book || !uid || !content) continue;
            out.push({ op, book, uid, content, ...secret });
        } else {
            const name = String(args.name ?? '').trim();
            const keys = Array.isArray(args.keys) ? [...new Set(args.keys.map((k) => String(k ?? '').trim()).filter(Boolean))].slice(0, MAX_LORE_KEYWORDS) : [];
            const secondaryKeys = Array.isArray(args.secondaryKeys) ? [...new Set(args.secondaryKeys.map((k) => String(k ?? '').trim()).filter(Boolean))].slice(0, MAX_LORE_KEYWORDS) : [];
            if (!name || !keys.length || !content) continue;
            out.push({ op, name, keys, secondaryKeys, content, ...secret });
        }
        if (out.length >= MAX_LORE_OPS) break;
    }
    return out;
}

export function parseLoomReply(raw, { livingLorePacket = null } = {}) {
    const text = String(raw ?? '');
    const prose = readLoomProse(text, { final: true });
    const envelope = readLoomEnvelope(text);
    let swaps = [];
    let requests = [];
    let flow = null;
    let loreKeywords = [];
    let loreOps = [];
    if (envelope.parsed) {
        try {
            const parsed = envelope.value;
            if (Array.isArray(parsed?.requests)) requests = parsed.requests;
            loreKeywords = readLoreKeywords(parsed?.loreKeywords);
            loreOps = readLoreOps(parsed?.loreOps);
            if (parsed?.flow && typeof parsed.flow === 'object') {
                flow = {
                    continueAfter: Boolean(parsed.flow.continue ?? parsed.flow.continueAfter),
                    hardPauseAfter: Boolean(parsed.flow.hardPause ?? parsed.flow.hardPauseAfter),
                };
            }
            if (Array.isArray(parsed?.swaps)) {
                swaps = parsed.swaps.filter((s) => s
                    && typeof s.find === 'string' && s.find.length > 0
                    && typeof s.replace === 'string');
            }
        } catch { swaps = []; requests = []; flow = null; }
    }
    return {
        prose, swaps, requests, flow, loreKeywords, loreOps,
    };
}

/**
 * A bounded, diagnostic view of one Loom reply.
 *
 * WHY THIS EXISTS: an Archive that does not advance looks identical from the
 * outside no matter which of three things went wrong — the model emitted no
 * state fence at all, it emitted one whose JSON does not parse, or it emitted
 * valid requests naming capabilities the Archive filter drops. Each needs a
 * different fix, and `archive.catchup.empty` distinguishes none of them.
 *
 * Deliberately a SUMMARY rather than the raw reply: the prose is already the
 * chat message, and re-journaling every turn in full would bury the signal in
 * the thing it is meant to explain. The tail is kept because that is where a
 * fence belongs, so its absence is visible rather than inferred.
 *
 * @param {string} raw
 * @param {{tailChars?: number, fenceChars?: number}} [options]
 */
export function describeLoomReply(raw, { tailChars = 400, fenceChars = 2000 } = {}) {
    const text = String(raw ?? '');
    const envelope = readLoomEnvelope(text);
    const parsed = parseLoomReply(text);
    return {
        length: text.length,
        proseLength: parsed.prose.length,
        hasFence: envelope.present,
        fenceParsed: envelope.parsed,
        fenceFormat: envelope.format,
        fenceJson: envelope.present ? envelope.json.slice(0, fenceChars) : '',
        capabilities: parsed.requests.map((request) => String(request?.capability || '(missing)')),
        requestCount: parsed.requests.length,
        swapCount: parsed.swaps.length,
        loreKeywordCount: parsed.loreKeywords.length,
        loreOpCount: parsed.loreOps.length,
        tail: text.slice(-tailChars),
    };
}

/**
 * Apply the Loom's swaps to the Narrator's draft, in code. Each swap
 * replaces the FIRST exact occurrence of its `find` span with `replace`. A swap
 * whose `find` is not present in the (progressively patched) draft is skipped —
 * never corrupt the prose over a paraphrased anchor. Returns the patched prose
 * and how many swaps actually landed.
 *
 * @param {string} draft
 * @param {{find: string, replace: string}[]} swaps
 * @returns {{ prose: string, applied: number }}
 */
export function applySwaps(draft, swaps) {
    let prose = String(draft ?? '');
    let applied = 0;
    for (const swap of Array.isArray(swaps) ? swaps : []) {
        if (!swap || typeof swap.find !== 'string' || !swap.find) continue;
        if (typeof swap.replace !== 'string') continue;
        if (!prose.includes(swap.find)) continue;
        prose = prose.replace(swap.find, swap.replace);
        applied += 1;
    }
    return { prose, applied };
}
