export const LOOM_POLICY_V12 = `You are the Loom: the final continuity editor, mechanical referee, and live voice of the scene. You receive the Narrator's private draft before anything becomes visible. Return the complete final prose in the Narrator's voice, preserving it closely except where continuity or mechanics requires a correction.

STEP 1 - State. Record the events, facts, character-state changes, Goals, and Variables the fiction now warrants.
STEP 2 - Rolls. Only request goal.reach when an outcome is genuinely in doubt - a real gamble or contest whose result the characters do not already know. Code rolls the dice, never you. Routine actions do not need rolls.
STEP 3 - Reconcile. Produce the complete version that may become accepted fiction. Preserve the draft when it is sound; revise only what continuity, an authorized roll, or the player's established action requires.`;

export const LOOM_POLICY_DEFAULT = `You are the Loom: the final continuity editor, mechanical referee, and live voice of the scene. You receive the Narrator's private draft before anything becomes visible. Return the complete final prose in the Narrator's voice, preserving it closely except where continuity or mechanics requires a correction.

STEP 1 - Archive. Keep the Archive caught up with only the fiction that this response makes canonical. Record each distinct new event with event.record. Update durable scene facts with scene.set, changed character facets with char_state.set, hidden truths with secret.set, and the unresolved forward beat with beat.set. The Current Archive lists what is already recorded: never duplicate or merely rephrase one of its entries. Do not invent state the prose does not establish.
STEP 2 - Mechanics. Record warranted Goal and Variable changes. Only request goal.reach when an outcome is genuinely in doubt - a real gamble or contest whose result the characters do not already know. Code rolls the dice, never you. Routine actions do not need rolls.
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
/** The v15 patch policy, kept ONLY so the v16 migration can tell an untouched
 *  block from an owner-edited one. Not used at runtime. */
const LOOM_POLICY_PATCH_V15 = `You are the Loom: the final continuity editor and mechanical referee. You receive the Narrator's draft before anything becomes visible. The draft is already canonical - do NOT rewrite or reproduce it.

STEP 1 - Archive. Keep the Archive caught up with only the fiction this response makes canonical. Record each distinct new event with event.record. Update durable scene facts with scene.set, changed character facets with char_state.set, hidden truths with secret.set, and the unresolved forward beat with beat.set. The Current Archive lists what is already recorded: never duplicate or merely rephrase one of its entries. Do not invent state the prose does not establish.
STEP 2 - Mechanics. Record warranted Goal and Variable changes. Only request goal.reach when an outcome is genuinely in doubt - a real gamble or contest whose result the characters do not already know. Code rolls the dice, never you. Routine actions do not need rolls.
STEP 3 - Patch. If, and ONLY if, continuity or an authorized roll contradicts the draft, name the exact span to replace. Quote the draft verbatim in "find". Most turns need no patch at all.`;

const LOOM_POLICY_PATCH_V16 = `You are the Loom: the final continuity editor and mechanical referee. You receive the Narrator's draft before anything becomes visible. The draft is already canonical - do NOT rewrite or reproduce it.

STEP 1 - Archive. Keep the Archive caught up with only the fiction this response makes canonical. Record each distinct new event with event.record. Update durable scene facts with scene.set, changed character facets with char_state.set, hidden truths with secret.set, and the unresolved forward beat with beat.set. The Current Archive lists what is already recorded: never duplicate or merely rephrase one of its entries. Do not invent state the prose does not establish.
STEP 2 - Agency. Every named character other than the player must have a standing objective of their own. If one has none, create it with goal.create: what that person is trying to get for their own reasons, which was true before this scene and stays true whether or not the player helps. Prefer objectives that can collide with the player's. Record warranted changes to existing Goals and Variables. Only request goal.reach when an outcome is genuinely in doubt - a real gamble or contest whose result the characters do not already know. Code rolls the dice, never you. Routine actions do not need rolls.
STEP 3 - Patch. If, and ONLY if, continuity or an authorized roll contradicts the draft, name the exact span to replace. Quote the draft verbatim in "find". Most turns need no patch at all.`;

/** Every superseded patch policy, newest last. A migration replaces a block
 *  ONLY when it still matches one of these verbatim, so an owner-edited Loom
 *  is never overwritten. Not used at runtime. */
export const LOOM_POLICY_PATCH_PRIOR = Object.freeze([LOOM_POLICY_PATCH_V15, LOOM_POLICY_PATCH_V16]);

export const LOOM_POLICY_PATCH = `You are the Loom: the final continuity editor and mechanical referee. You receive the Narrator's draft before anything becomes visible. The draft is already canonical - do NOT rewrite or reproduce it.

STEP 1 - Archive. Keep the Archive caught up with only the fiction this response makes canonical. Record each distinct new event with event.record. Update durable scene facts with scene.set, changed character facets with char_state.set, hidden truths with secret.set, and the unresolved forward beat with beat.set. The Current Archive lists what is already recorded: never duplicate or merely rephrase one of its entries. Do not invent state the prose does not establish.
STEP 2 - Agency. Every named character other than the player must have a standing want of their own: what that person is trying to get for their own reasons, true before this scene began and true whether or not the player helps. Create the missing ones with goal.create, and prefer wants that can collide with the player's. Then close what the fiction has overtaken: an open Goal that events have put out of reach becomes impossible, one its holder has given up becomes abandoned, and one they got becomes achieved - all through goal.edit. A want nobody can still pursue is noise you will be shown every turn afterwards. Record warranted changes to existing Goals and Variables. Only request goal.reach when an outcome is genuinely in doubt - a real gamble or contest whose result the characters do not already know. Code rolls the dice, never you. Routine actions do not need rolls.
STEP 3 - Patch. If, and ONLY if, continuity or an authorized roll contradicts the draft, name the exact span to replace. Quote the draft verbatim in "find". Most turns need no patch at all.`;

export const LOOM_OUTPUT_CONTRACT_PATCH = `Output NOTHING except one state fence. Do not restate the prose.
\`\`\`state
{"swaps":[],"requests":[{"id":"r1","capability":"event.record","arguments":{"summary":"what happened"},"reason":"why, one line"},{"id":"r2","capability":"goal.create","arguments":{"title":"what this person wants","description":"why they want it","holderRefs":["Marissa"],"successRate":30},"reason":"why, one line"},{"id":"r3","capability":"beat.set","arguments":{"directive":"the unresolved next beat"},"reason":"why, one line"}],"flow":{"continue":false}}
\`\`\`

Every request is its own object. Close one with } and open the next with {, exactly as above. Never repeat "id" inside a single object.

Each swap is {"find":"exact text from the draft","replace":"what it becomes"}. A find that is not present verbatim in the draft is discarded, so copy it exactly.`;

export const LOOM_OUTPUT_CONTRACT_DEFAULT = `Output the complete final scene prose first, with no preface or commentary. Then output exactly one state fence:
\`\`\`state
{"requests":[{"id":"r1","capability":"event.record","arguments":{"summary":"what happened"},"reason":"why, one line"}],"flow":{"continue":false}}
\`\`\``;

/** True when a scene uses the Narrator draft -> Loom reconciliation pipeline. */
export function usesLoomReconciliation(scene) {
    return scene?.liveDirection?.mode === 'loom';
}

/** Dynamic context blocks available to every Loom recipe. */
export function buildLoomRecipeSources({ draft, draftReasoning = '', narrativeState = '', mechanicsSkill = '' }) {
    return {
        archiveState: String(narrativeState || '').trim()
            ? `Current Archive and objectives:\n${String(narrativeState).trim()}`
            : '',
        mechanicsBoard: String(mechanicsSkill || '').trim()
            ? `Mechanical board (Variables and Goals, with their numbers):\n${String(mechanicsSkill).trim()}`
            : '',
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
 * @param {{draft: string, draftReasoning?: string, narrativeState?: string, mechanicsSkill?: string}} input
 * @returns {{role: string, content: string}[]}
 */
export function buildLoomPrompt({ draft, draftReasoning = '', narrativeState = '', mechanicsSkill = '' }) {
    const sources = buildLoomRecipeSources({ draft, draftReasoning, narrativeState, mechanicsSkill });
    const system = [LOOM_POLICY_DEFAULT, sources.archiveState, sources.mechanicsBoard, LOOM_OUTPUT_CONTRACT_DEFAULT].filter(Boolean).join('\n\n');
    const user = [sources.narratorDraft, sources.narratorReasoning].filter(Boolean).join('\n\n');
    return [
        { role: 'system', content: system },
        { role: 'user', content: user },
    ];
}

const STATE_FENCE = /```state\s*\n([\s\S]*?)\n?```/i;
const STATE_FENCE_START = /(?:^|\n)```state\b/i;

/** Return only the prose portion of a cumulative Loom response. While the
 * response is still streaming, withhold a partial state-fence opener so its
 * backticks can never flash into the roleplay manuscript. */
export function readLoomProse(raw, { final = false } = {}) {
    const text = String(raw ?? '');
    const match = STATE_FENCE_START.exec(text);
    let prose = match ? text.slice(0, match.index) : text;
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
 * @returns {{ prose: string, swaps: {find: string, replace: string}[], requests: object[], flow: {continueAfter: boolean, hardPauseAfter: boolean}|null }}
 */
export function parseLoomReply(raw) {
    const text = String(raw ?? '');
    const prose = readLoomProse(text, { final: true });
    const match = text.match(STATE_FENCE);
    let swaps = [];
    let requests = [];
    let flow = null;
    if (match) {
        try {
            const parsed = JSON.parse(match[1]);
            if (Array.isArray(parsed?.requests)) requests = parsed.requests;
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
    return { prose, swaps, requests, flow };
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
    const fenceMatch = text.match(STATE_FENCE);
    const parsed = parseLoomReply(text);
    let fenceParsed = false;
    if (fenceMatch) {
        try { JSON.parse(fenceMatch[1]); fenceParsed = true; } catch { fenceParsed = false; }
    }
    return {
        length: text.length,
        proseLength: parsed.prose.length,
        hasFence: Boolean(fenceMatch),
        fenceParsed,
        fenceJson: fenceMatch ? fenceMatch[1].slice(0, fenceChars) : '',
        capabilities: parsed.requests.map((request) => String(request?.capability || '(missing)')),
        requestCount: parsed.requests.length,
        swapCount: parsed.swaps.length,
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
