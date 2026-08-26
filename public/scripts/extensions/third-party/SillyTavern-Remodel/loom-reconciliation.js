import { parseLivingLoreProposals } from './living-lore-proposals.js';

export const LOOM_POLICY_V12 = `You are the Loom: the final continuity editor, mechanical referee, and live voice of the scene. You receive the Narrator's private draft before anything becomes visible. Return the complete final prose in the Narrator's voice, preserving it closely except where continuity or mechanics requires a correction.

STEP 1 - State. Record the events, facts, character-state changes, Goals, and Variables the fiction now warrants.
STEP 2 - Rolls. Only request goal.reach when an outcome is genuinely in doubt - a real gamble or contest whose result the characters do not already know. Code rolls the dice, never you. Routine actions do not need rolls.
STEP 3 - Reconcile. Produce the complete version that may become accepted fiction. Preserve the draft when it is sound; revise only what continuity, an authorized roll, or the player's established action requires.`;

export const LOOM_POLICY_DEFAULT_PRIOR = `You are the Loom: the final continuity editor, mechanical referee, and live voice of the scene. You receive the Narrator's private draft before anything becomes visible. Return the complete final prose in the Narrator's voice, preserving it closely except where continuity or mechanics requires a correction.

STEP 1 - Archive. Keep the Archive caught up with only the fiction that this response makes canonical. Record each distinct new event with event.record. Update durable scene facts with scene.set, changed character facets with char_state.set, hidden truths with secret.set, and the unresolved forward beat with beat.set. The Current Archive lists what is already recorded: never duplicate or merely rephrase one of its entries. Do not invent state the prose does not establish.
STEP 2 - Mechanics. Record warranted Goal and Variable changes. Only request goal.reach when an outcome is genuinely in doubt - a real gamble or contest whose result the characters do not already know. Code rolls the dice, never you. Routine actions do not need rolls.
STEP 3 - Reconcile. Produce the complete version that may become accepted fiction. Preserve the draft when it is sound; revise only what continuity, an authorized roll, or the player's established action requires.`;

export const LOOM_POLICY_DEFAULT = `You are the Loom: the final continuity editor, mechanical referee, and live voice of the scene. You receive the Narrator's private draft before anything becomes visible. Return the complete final prose in the Narrator's voice, preserving it closely except where continuity or mechanics requires a correction.

STEP 1 - Archive. Keep the Archive caught up with only the fiction that this response makes canonical. Record each distinct new event with event.record. Update durable scene facts with scene.set, changed character facets with char_state.set, hidden truths with secret.set, and the unresolved open thread with beat.set. Never duplicate an existing Archive entry. A beat is provisional momentum, never a guaranteed outcome and never stronger than the latest accepted action.
STEP 2 - Consequences. Goals describe outcomes their holders are trying to achieve, never outcomes the story must protect. Ask what materially changed because this turn happened. A Goal's description guides measurement but is not an exhaustive whitelist: if new fiction reveals that its condition is incomplete, refine the description with goal.edit rather than declaring the action irrelevant. When fiction helps or obstructs an open Goal, use goal.edit to set its Success Rate to the holder's new chance, even when no roll is needed. Close achieved, abandoned, or impossible Goals. Create a Goal only for a meaningful unresolved outcome worth tracking, never merely because a named character lacks one. Use goal.reach only for a decisive attempt whose outcome is genuinely uncertain. Code rolls the dice, never you.
STEP 3 - Reconcile. Produce the complete version that may become accepted fiction. Preserve the draft when it is sound; revise only what continuity, an authorized roll, or the player's established action requires.`;

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

STEP 1 - Archive. Keep the Archive caught up with only the fiction this response makes canonical. Record each distinct new event with event.record. Update durable scene facts with scene.set, changed character facets with char_state.set, hidden truths with secret.set, and the unresolved open thread with beat.set. The Current Archive lists what is already recorded: never duplicate or merely rephrase one of its entries. Do not invent state the prose does not establish. A beat is provisional momentum, never a guaranteed outcome and never stronger than the latest accepted action.
STEP 2 - Consequences. Goals describe outcomes their holders are trying to achieve, never outcomes the story must protect. Ask what materially changed because this turn happened. A Goal's description guides measurement but is not an exhaustive whitelist: if new fiction reveals that its condition is incomplete, refine the description with goal.edit rather than declaring the action irrelevant. When the fiction helps or obstructs an open Goal, use goal.edit to set its Success Rate to the holder's new chance of achieving it, even when no roll is needed. Small pressure may move it a few points; a meaningful reversal should move it substantially. Close a Goal with goal.edit when it becomes achieved, abandoned, or impossible. Use goal.create only when the fiction establishes a meaningful unresolved outcome worth tracking, never merely because a named character lacks one. Use goal.reach only for a decisive attempt whose outcome is genuinely uncertain; routine or already-established consequences need no roll. Code rolls the dice, never you.
STEP 3 - Patch. If, and ONLY if, continuity or an authorized roll contradicts the draft, name the exact span to replace. Quote the draft verbatim in "find". Most turns need no patch at all.
STEP 4 - Durable Lore Check. When a Selected Living Lore packet is present, ask whether this accepted fiction establishes information that will remain useful beyond the immediate moment. Propose precise evidence-backed lore changes for a meaningfully reusable person, place, group, institution, stable relationship, discovered rule, persistent condition, or durable open thread. Do not promote transient actions, momentary moods or positions, scene summaries, decorative details, or facts already represented in the Archive or selected lore. A named extra appearing once is not automatically durable lore. Most turns may correctly return no proposals.`;

const LOOM_OUTPUT_CONTRACT_PATCH_V21 = `Output NOTHING except one state fence. Do not restate the prose.
\`\`\`state
{"swaps":[],"requests":[{"id":"r1","capability":"event.record","arguments":{"summary":"what happened"},"reason":"why, one line"},{"id":"r2","capability":"goal.edit","arguments":{"goalRef":"the exact Goal name","successRate":23},"reason":"how this turn changed its holder's position"},{"id":"r3","capability":"beat.set","arguments":{"directive":"the unresolved thread after this turn"},"reason":"why, one line"}],"loreProposals":[],"flow":{"continue":false}}
\`\`\`

Every request is its own object. Close one with } and open the next with {, exactly as above. Never repeat "id" inside a single object.

Each swap is {"find":"exact text from the draft","replace":"what it becomes"}. A find that is not present verbatim in the draft is discarded, so copy it exactly.`;

const LOOM_OUTPUT_CONTRACT_PATCH_PRE_LORE = LOOM_OUTPUT_CONTRACT_PATCH_V21
    .replace('],"loreProposals":[],"flow"', '],"flow"');

export function isSupersededLoomPatchContract(value) {
    return value === LOOM_OUTPUT_CONTRACT_PATCH_V21
        || value === LOOM_OUTPUT_CONTRACT_PATCH_PRE_LORE
        // The compact v15 contract persisted in stores seeded before the
        // expanded goal examples were introduced.
        || policyFingerprint(value) === '397:3fa9c0d4';
}

export const LOOM_OUTPUT_CONTRACT_PATCH = `Output NOTHING except one state fence. Do not restate the prose.
\`\`\`state
{"swaps":[],"requests":[{"id":"r1","capability":"event.record","arguments":{"summary":"what happened"},"reason":"why, one line"},{"id":"r2","capability":"goal.edit","arguments":{"goalRef":"the exact Goal name","successRate":23},"reason":"how this turn changed its holder's position"},{"id":"r3","capability":"beat.set","arguments":{"directive":"the unresolved thread after this turn"},"reason":"why, one line"}],"loreProposals":[],"flow":{"continue":false}}
\`\`\`

Every request is its own object. Close one with } and open the next with {, exactly as above. Never repeat "id" inside a single object.

Always include the top-level loreProposals array. Leave it empty when the Durable Lore Check finds no warranted change; otherwise follow the Selected Living Lore proposal shape exactly.

Each swap is {"find":"exact text from the draft","replace":"what it becomes"}. A find that is not present verbatim in the draft is discarded, so copy it exactly.`;

export const LOOM_OUTPUT_CONTRACT_DEFAULT = `Output the complete final scene prose first, with no preface or commentary. Then output exactly one state fence:
\`\`\`state
{"requests":[{"id":"r1","capability":"event.record","arguments":{"summary":"what happened"},"reason":"why, one line"}],"loreProposals":[],"flow":{"continue":false}}
\`\`\``;

/** True when a scene uses the Narrator draft -> Loom reconciliation pipeline. */
export function usesLoomReconciliation(scene) {
    return scene?.liveDirection?.mode === 'loom';
}

/** Dynamic context blocks available to every Loom recipe. */
export function buildLoomRecipeSources({ draft, draftReasoning = '', narrativeState = '', mechanicsSkill = '', livingLore = '' }) {
    return {
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
 * The Loom prompt. The Loom is the final continuity editor and mechanical
 * referee: it reads the Narrator's private draft, records the state the fiction
 * now warrants, and returns the COMPLETE final prose that may become accepted
 * fiction — preserving the draft closely except where continuity or an
 * authorized roll requires a correction. Dice are rolled by code, never by the
 * model. The older preserve-and-patch contract, in which the draft was kept
 * verbatim and the model named only find/replace spans, survives as a
 * compatibility fallback for owner-authored recipes — see parseLoomReply.
 *
 * @param {{draft: string, draftReasoning?: string, narrativeState?: string, mechanicsSkill?: string, livingLore?: string}} input
 * @returns {{role: string, content: string}[]}
 */
export function buildLoomPrompt({ draft, draftReasoning = '', narrativeState = '', mechanicsSkill = '', livingLore = '' }) {
    const sources = buildLoomRecipeSources({ draft, draftReasoning, narrativeState, mechanicsSkill, livingLore });
    const system = [LOOM_POLICY_DEFAULT, sources.archiveState, sources.mechanicsBoard, sources.livingLore, LOOM_OUTPUT_CONTRACT_DEFAULT].filter(Boolean).join('\n\n');
    const user = [sources.narratorDraft, sources.narratorReasoning].filter(Boolean).join('\n\n');
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
            const repaired = repairQuotedRequestObjects(stateMatch[1]);
            if (repaired !== stateMatch[1]) {
                try {
                    const value = JSON.parse(repaired);
                    if (isLoomEnvelope(value)) {
                        return { present: true, parsed: true, format: 'state-quoted-object-repaired', json: repaired, value };
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
        && (Array.isArray(value.requests) || Array.isArray(value.swaps) || Array.isArray(value.loreProposals)
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
 * @returns {{ prose: string, swaps: {find: string, replace: string}[], requests: object[], flow: {continueAfter: boolean, hardPauseAfter: boolean}|null, loreProposals: object[], loreProposalRejections: object[] }}
 */
export function parseLoomReply(raw, { livingLorePacket = null } = {}) {
    const text = String(raw ?? '');
    const prose = readLoomProse(text, { final: true });
    const envelope = readLoomEnvelope(text);
    let swaps = [];
    let requests = [];
    let flow = null;
    let loreProposals = [];
    let loreProposalRejections = [];
    if (envelope.parsed) {
        try {
            const parsed = envelope.value;
            if (Array.isArray(parsed?.requests)) requests = parsed.requests;
            const proposals = parseLivingLoreProposals(parsed?.loreProposals, livingLorePacket);
            loreProposals = proposals.accepted;
            loreProposalRejections = proposals.rejected;
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
        } catch { swaps = []; requests = []; flow = null; loreProposals = []; loreProposalRejections = []; }
    }
    return { prose, swaps, requests, flow, loreProposals, loreProposalRejections };
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
        loreProposalCount: parsed.loreProposals.length,
        loreProposalRejectedCount: parsed.loreProposalRejections.length,
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
