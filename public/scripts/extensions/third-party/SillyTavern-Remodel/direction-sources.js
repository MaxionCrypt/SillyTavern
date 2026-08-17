// The content behind each source block of a Director recipe.
//
// PURE — takes a snapshot, returns strings. Keeping it free of context imports
// means the exact text sent to the Director can be asserted in tests.

/**
 * @param {object} snapshot the direction snapshot
 * @param {{mechanicsEnabled: boolean}} options
 * @returns {{directionProtocol: string, directorCard: string, mechanicsSkill: string,
 *   directorNotebook: (settings?: {depth?: number}) => string, directorSnapshot: string}}
 *
 * `directorNotebook` is a FUNCTION, not a string, and it is the only one.
 * `compilePromptRecipe` resolves a function-form source by calling it with the
 * block's own `settings` (prompt-studio.js), which is how a per-block setting
 * reaches a source without ever becoming part of what is sent — design §5's
 * third consequence. Every other source here has nothing to configure, so
 * every other source is a plain string.
 */
export function buildDirectionSources(snapshot, { mechanicsEnabled = false } = {}) {
    return {
        directionProtocol: PROTOCOL,
        directorCard: snapshot?.director ? describeCard(snapshot.director) : '',
        mechanicsSkill: describeMechanics(snapshot?.mechanics, { mechanicsEnabled }),
        directorNotebook: (settings) => describeNotebook(snapshot?.notebook, settings?.depth),
        directorSnapshot: describeSnapshot(snapshot),
    };
}

// Contract only. Pacing, autonomy and response length live in the recipe's
// editable style block, not here — that was the point of the rework.
//
// The tag block and the closing fence are drawn from the design spec (§2,
// "What the Director badge contributes"), so this text and that record
// cannot silently drift apart. The fence stays the literal last thing in the
// string on purpose — a state block is only ever the last thing in a real
// reply, and `tests/remodel-direction-sources.test.js` extracts this same
// block by slicing from the first tag to the end of the string, so a
// mutated tag or a moved fence surfaces there too.
//
// THE UNTAGGED-LINE SENTENCE IS LOAD-BEARING AND WAS WRONG. It used to read
// "A line with no tag is read as a note", which is not what `readEntries`
// (director-reply.js) does and not what design §3 specifies: an untagged line
// is appended to the PREVIOUS entry, and only untagged prose that LEADS the
// reply becomes a note of its own. The difference is not cosmetic — under the
// old wording a Director could write a `[secret]` and then, on the next line,
// colour it believed would reach the performer as a note, and that colour was
// silently withheld instead. The contract is what moved, not the parser: the
// parser's behaviour is the design's, and it is what makes a multi-line entry
// possible at all — a Director cannot write a paragraph-length ruling if every
// newline starts a new note. Changing the parser would have bought the
// sentence at the cost of the feature.
//
// The example request below deliberately does NOT match the design spec's
// own wording. The spec's §2 example wrote a flat
// `{capability, name, amount}`, but the code that actually consumes a
// request reads a different shape entirely — validateMechanicsRequest
// (mechanics-capabilities.js:155-171) requires four TOP-LEVEL fields (`id`,
// unique within the batch; `capability`, a key of CAPABILITIES; `arguments`,
// a nested object — not flattened onto the request; `reason`, non-empty),
// and only inside `arguments` does addressRequestsByName
// (live-direction.js) read `variableRef`/`delta` for variable.adjust. The
// capability dictionary rendered into this same prompt (describeCapabilities,
// fed by mechanics-capabilities.js's own field descriptions) already teaches
// the nested shape and those field names, so documenting anything else here
// would hand the Director two contradictory vocabularies for the same
// request inside one prompt — worse than either being wrong alone. This
// block corrects the spec's shape rather than reproducing it. `variableRef`
// reads oddly now that its value is a name rather than a ref; that is the
// established post-rework convention (the field kept its name when its
// value changed), not a mistake to fix here.
const PROTOCOL = `You are the hidden director of this scene. You never speak in the story and are never quoted.
Keep a notebook instead of a script. Write your entries one per line, each starting with one of these tags — your only instructions to the performer, nothing else survives outside them:
[note]   observation, colour, what is in the air
[ruling] a decision that binds the next response
[result] what actually happened, for the record
[secret] never shown to the performer, and never omitted when a Goal or twist must stay hidden
A line with no tag continues the entry above it; untagged prose written before your first tag is read as a note. Address every Variable and every Goal by its exact name as given to you below — never invent a name, never use an internal reference, and never describe this contract in your reply.
If, and only if, anything mechanical changed this turn, close with a single fenced state block naming what changed by that same exact name. Otherwise leave it out entirely:
\`\`\`state
{"requests":[{"id":"r1","capability":"variable.adjust","arguments":{"variableRef":"Morale","delta":-1},"reason":"the in-fiction reason this happened, one sentence"}],"flow":{"continue":false}}
\`\`\``;

/**
 * The Director reading its OWN notebook back — including the secrets.
 *
 * WHY THIS EXISTS: the notebook was write-only from the Director's side. Its
 * entries reached the Narrator (filtered) and the owner's panel, and nothing
 * fed them back to their author, so a `[secret]` recorded on turn 4 reached
 * NOBODY afterwards — not the Narrator by design, and not the Director because
 * nothing carried it. A hidden twist could not survive one turn, in a design
 * whose decision table promises "an active member with a persistent notebook,
 * not a one-shot instruction" and whose contract tells the model to use
 * `[secret]` "when a Goal or twist must stay hidden". `ruling` and `result`
 * fared slightly better only because the Narrator's prose echoes them back
 * into chat history; a secret has no such echo by construction.
 *
 * SECRETS ARE INCLUDED HERE ON PURPOSE, and it is not a weakening of the
 * secret guarantee — it is what the guarantee is FOR. The Director is the
 * author and owner of its secrets; only the NARRATOR is excluded. The
 * separation is structural rather than remembered: this text is only ever a
 * `director`-mode recipe source, and the one funnel to the Narrator
 * (`formatDirectorNotesPrompt` -> `readNarratorEntries`) filters `secret` at
 * the store boundary and cannot reach this function.
 *
 * `abandoned` entries are excluded, and — as in `readNarratorEntries` —
 * BEFORE the depth window rather than after, because a cancelled take did not
 * happen at all and must not push a real turn out of view. Secrets are
 * inside the window for the same reason they are inside the Narrator's: that
 * turn happened.
 *
 * @param {Array<{turn: number, type: string, text: string, abandoned?: boolean}>} entries
 *        every stored entry for this Scene, oldest first
 * @param {number} depth how many TURNS to include, counted like the
 *        Narrator's: a turn arrives whole or not at all. A missing or
 *        unusable depth renders nothing — the value is a declared block
 *        setting the recipe normaliser always fills, so its absence means a
 *        caller outside the recipe path, and dumping an unbounded notebook
 *        into a prompt is a worse answer there than dumping none.
 */
function describeNotebook(entries, depth) {
    const turns = notebookTurnsAscending((Array.isArray(entries) ? entries : []).filter((entry) => entry && !entry.abandoned), depth);
    const body = turns
        .map(([turn, turnEntries]) => {
            const lines = turnEntries.map(describeNotebookEntry).filter(Boolean);
            return lines.length ? `Turn ${turn}\n${lines.join('\n')}` : '';
        })
        .filter(Boolean)
        .join('\n\n');
    if (!body) return '';
    return `[YOUR NOTEBOOK — what you wrote on earlier turns of this Scene. The performer never saw the secret entries and still has not.]\n${body}`;
}

/**
 * The last `depth` turns present, oldest first — the same ordering STORY SO
 * FAR uses, so the newest turn lands closest to the request.
 *
 * A local grouper rather than a shared one because this module is pure by
 * contract and the two existing groupers both live in modules that import
 * `st-context.js`. Deliberately NOT named `groupNotebookEntriesByTurn`: there
 * are already two functions with that name and opposite sorts
 * (live-direction.js ascending, timeline-spine.js descending), and adding a
 * third would make the name mean nothing at all.
 */
function notebookTurnsAscending(entries, depth) {
    const window = Math.max(0, Math.floor(Number(depth)) || 0);
    if (!window) return [];
    const byTurn = new Map();
    for (const entry of entries) {
        const turn = Number.isFinite(Number(entry.turn)) ? Number(entry.turn) : 0;
        if (!byTurn.has(turn)) byTurn.set(turn, []);
        byTurn.get(turn).push(entry);
    }
    const ordered = [...byTurn.entries()].sort((a, b) => a[0] - b[0]);
    return ordered.slice(Math.max(0, ordered.length - window));
}

/**
 * Labels the four types for their author.
 *
 * A separate map from the Narrator's (live-direction.js's
 * NOTEBOOK_ENTRY_LABELS) rather than a shared one, because the difference is
 * the point: this one has a `secret` label, and the Narrator's cannot ever
 * have one — there is no entry it could caption. Sharing a map between a
 * reader that must never see a type and a reader that must would put the two
 * one edit apart.
 */
const NOTEBOOK_LABELS = Object.freeze({
    ruling: 'Ruling, still binding: ',
    result: 'Established: ',
    secret: 'Secret, never shown to the performer: ',
});

function describeNotebookEntry(entry) {
    const text = String(entry?.text || '').trim();
    if (!text) return '';
    return `- ${NOTEBOOK_LABELS[entry?.type] || ''}${text}`;
}

function describeCard(director) {
    return `[DIRECTOR CARD — directing temperament, not dialogue]
The director for this scene is ${director.label}. Use this material as judgment, priorities and genre sense. Never speak as this character.
Description: ${director.description || '(none)'}
Personality: ${director.personality || '(none)'}
Scenario: ${director.scenario || '(none)'}
Creator notes: ${director.creatorNotes || '(none)'}
System prompt: ${director.systemPrompt || '(none)'}
Post-history instructions: ${director.postHistoryInstructions || '(none)'}`;
}

/**
 * Everything the Director may read about persistent state, and — when
 * mechanics are on — everything it may ask to change.
 *
 * Rendered rather than JSON-dumped, and rendered WITHOUT the temporary
 * `v1`/`g1` refs the layers underneath still use as internal keys. Names are
 * the only address now (design §3), so a ref appearing anywhere in this text
 * is an invitation to reply with one.
 *
 * When mechanics are disabled this still renders. It used to return '', which
 * `compilePromptRecipe` then dropped entirely — leaving a Director with no
 * Variables, no Goals, no statement that anything was off, and a schema still
 * demanding a `requests` array it had nothing to fill from.
 */
function describeMechanics(mechanics, { mechanicsEnabled = false } = {}) {
    const goals = Array.isArray(mechanics?.goals) ? mechanics.goals : [];
    // The one place refs are still read: relationships and the user's attached
    // attempts arrive keyed by `g1…gN` (buildMechanicalSnapshot), and both are
    // resolved back to titles here rather than being printed raw. Refless
    // Goals are excluded so an unresolved relationship endpoint — which
    // describeRelations renders as '' — cannot accidentally match one.
    const titleByRef = new Map(goals.filter((goal) => goal.ref && goal.title).map((goal) => [goal.ref, goal.title]));
    const sections = [
        mechanicsEnabled ? section('CAPABILITIES', describeCapabilities(mechanics?.capabilities)) : '',
        section('VARIABLES', mechanics?.serializedVariables || '(none retrieved this turn)', describeRetrieval(mechanics?.retrieval)),
        section('GOALS', goals.map(describeGoal).join('\n') || '(none active)'),
        section('RELATIONSHIPS', describeRelationships(mechanics?.relationships, titleByRef)),
        section('ATTEMPTED THIS TURN', describeAttempts(mechanics?.authorizedGoalRefs, titleByRef)),
    ].filter(Boolean);
    return [heading(mechanicsEnabled), ...sections, closing(mechanicsEnabled, mechanics)].filter(Boolean).join('\n\n');
}

function heading(mechanicsEnabled) {
    const title = '[GOALS AND VARIABLES — persistent memory, not a turn structure]';
    return mechanicsEnabled
        ? `${title}\nAddress each one by the exact name below. A name you were not given will be rejected. Never invent an identifier, never roll dice, never change state yourself — request it and code will validate and apply it.`
        : `${title}\nMechanical automation is unavailable this turn, so everything below is read-only: treat it as established fact your direction must respect, and return an empty requests array. Never roll dice or narrate a change to any value below.`;
}

function closing(mechanicsEnabled, mechanics) {
    if (!mechanicsEnabled) return '';
    const duplicates = mechanics?.addressBook?.duplicates || [];
    return duplicates.length
        ? `Unusable — these names are duplicated in this Timeline and cannot be addressed: ${duplicates.join(', ')}`
        : '';
}

/** A heading with nothing under it tells the Director less than no heading. */
function section(title, body, note = '') {
    const content = String(body || '').trim();
    if (!content) return '';
    // The note is its own paragraph: run up against the last entry it reads as
    // part of that entry rather than as a caveat on the whole list.
    return [`${title}\n${content}`, note].filter(Boolean).join('\n\n');
}

/**
 * One Goal, with the fields the capability dictionary actually acts on.
 *
 * `successRate` above all: `goal.shift` exists to move exactly this number by
 * a named band, and the Director was previously shown only title and status —
 * asked to shift a value it could not read.
 */
function describeGoal(goal) {
    const facets = [goal.status, goal.visibility].filter(Boolean).join(', ');
    const rate = Number.isFinite(Number(goal.successRate)) ? ` — ${Number(goal.successRate)}%` : '';
    const detail = [
        goal.description,
        describeOwners('Held by', goal.holderRefs),
        describeOwners('Against', goal.targetRefs),
        describeGoalResolution(goal.resolution),
    ].filter(Boolean).map((line) => `  ${line}`);
    return [`- ${goal.title}${rate}${facets ? ` (${facets})` : ''}`, ...detail].join('\n');
}

function describeOwners(label, refs) {
    const names = (Array.isArray(refs) ? refs : []).map((ref) => ref?.label).filter(Boolean);
    return names.length ? `${label}: ${names.join(', ')}` : '';
}

/**
 * What a tracked Goal tracks, named the way everything else is now.
 *
 * `variableName` is supplied by mechanics-runtime.js's describeResolution; it
 * used to be `variableRef`, which would have reintroduced `v1` into the prompt
 * the moment this block started rendering resolutions at all.
 */
function describeGoalResolution(resolution) {
    if (!resolution || resolution.kind !== 'tracked') return '';
    if (!resolution.variableName) return `Tracks a Variable that was not retrieved this turn${resolution.note ? ` — ${resolution.note}` : ''}.`;
    const direction = resolution.direction === 'decrease' ? 'down to' : 'up to';
    const threshold = resolution.completionThreshold ?? null;
    const field = resolution.field && resolution.field !== 'value' ? ` (${resolution.field})` : '';
    return `Tracks ${resolution.variableName}${field}, achieved when it goes ${direction} ${threshold}.`;
}

function describeRelationships(relationships, titleByRef) {
    return (Array.isArray(relationships) ? relationships : []).map((relation) => {
        const from = titleByRef.get(relation.fromRef);
        const to = titleByRef.get(relation.toRef);
        if (!from || !to) return '';
        return `- ${from} → ${to} (${relation.type || 'related'})${relation.reason ? `: ${relation.reason}` : ''}`;
    }).filter(Boolean).join('\n');
}

/**
 * The Goal attempts the user attached to this action.
 *
 * `isAuthorizedGoal` still gates persona-held Goals on exactly these, and the
 * Roleplay preview still promises the user they "will be assessed by the
 * hidden Game Director when sent" — so the Director has to be told which ones.
 */
function describeAttempts(authorizedGoalRefs, titleByRef) {
    const titles = (Array.isArray(authorizedGoalRefs) ? authorizedGoalRefs : [])
        .map((ref) => titleByRef.get(ref)).filter(Boolean);
    if (!titles.length) return '';
    return [
        'The user attached these Goal attempts to the current action. Judge them in this direction.',
        ...titles.map((title) => `- ${title}`),
    ].join('\n');
}

/**
 * Retrieval that fell back is a caveat on the Variable list, not a section.
 *
 * Deliberately no `retrieval.warning`. That field holds a raw transport error
 * — observed reaching the Director as "Failed to parse URL from
 * /api/vector/list" — which tells the model nothing it can act on and asks it
 * to parse machine text mid-prompt. What it needs is the consequence: this
 * list may be short. The error itself is already journalled by
 * variables-context.js (`retrieval.resolved`, `degradeCause`), which is where
 * it is useful, and it stays on the snapshot for the debug surfaces.
 */
function describeRetrieval(retrieval) {
    if (!retrieval?.degraded) return '';
    return 'Semantic retrieval was unavailable this turn, so this list was selected by direct reference alone and may be missing Variables that are relevant.';
}

/**
 * The verbs a Director's `requests` may name, spelled out rather than left
 * for the model to infer from a record's shape. Without this list a Director
 * can see a Variable or Goal in the snapshot above and have no idea what may
 * be asked of it — the dictionary existed for exactly this before the
 * compiled-recipe rework dropped it.
 *
 * Read from the snapshot rather than imported from mechanics-capabilities.js
 * directly: that module pulls in variables-store.js/story-goals-store.js,
 * which import st-context.js, and this module must not. mechanics-runtime.js
 * puts `getCapabilityDictionary()`'s output into `mechanics.capabilities` for
 * exactly this reason.
 */
function describeCapabilities(capabilities) {
    return (Array.isArray(capabilities) ? capabilities : [])
        .map((capability) => `- ${capability.name} (${capability.applicableKinds.join(', ')}): ${capability.description}`)
        .join('\n');
}

/**
 * Everything the Director may read about the scene it is directing: where it
 * is, who is in it, what has been said, and what has just happened.
 *
 * Rendered, not JSON-dumped, for the same reason every other block here is.
 * A `{"id":137,"role":"assistant","name":"Sera","content":"…"}` record spends
 * tokens on punctuation and field names to state what `Sera: …` states for
 * free, and asks the model to parse a transport format before it can read a
 * story.
 *
 * Nothing here emits an identifier. The Director's reply is tagged lines plus
 * a `state` fence — there is no envelope any more, and no field in either that
 * takes a scene id, a cast ref or a message id; `requests` addresses Variables
 * and Goals by name against a closed set (design §3). An identifier in this
 * text is therefore an address that cannot be used and can only be echoed.
 * The snapshot OBJECT keeps all of them; this is a rendering, and callers that
 * need `snapshot.scene.id` read the object.
 *
 * Fields are picked explicitly rather than spread, so a new snapshot field
 * starts life unrendered rather than arriving in the prompt — ids included —
 * because someone added it upstream.
 */
function describeSnapshot(snapshot) {
    const { scene, currentAction, cast, narratorRef, persona, acceptedHistory, lore, recentReceipts } = snapshot || {};
    return [
        section('SCENE', scene?.title),
        section('PERFORMER', describePerformer(narratorRef)),
        section('CAST', describeCast(cast)),
        section('PERSONA', describePersona(persona)),
        section('LORE', describeLore(lore)),
        section('RECENT CHANGES', describeReceipts(recentReceipts)),
        section('STORY SO FAR', describeHistory(acceptedHistory, persona)),
        // Last, and alone under its own heading: this is the event the
        // direction is about, and it is the one line here that is not also
        // inside STORY SO FAR. The user's message IS written to the chat
        // before this pass asks the Director anything now (beginDirection
        // posts it ahead of building this very snapshot), which would put it
        // in context.chat's newest slot — but buildDirectionSnapshot leaves
        // that same newest entry out of acceptedHistory, so it still reaches
        // this prompt exactly once, here, rather than twice.
        section('CURRENT ACTION', currentAction),
    ].filter(Boolean).join('\n\n');
}

/** By name. `narratorRef.id` is an avatar filename, which addresses nothing here. */
function describePerformer(narratorRef) {
    const label = String(narratorRef?.label || '').trim();
    return label ? `${label} writes the next response.` : '';
}

function describeCast(cast) {
    return (Array.isArray(cast) ? cast : []).map((member) => {
        const label = String(member?.label || '').trim();
        if (!label) return '';
        const detail = [
            describeField('Description', member.description),
            describeField('Personality', member.personality),
            describeField('Scenario', member.scenario),
        ].filter(Boolean);
        return [`- ${label}`, ...detail].join('\n');
    }).filter(Boolean).join('\n');
}

/** Card fields run to paragraphs; every line of one stays under its bullet. */
function describeField(label, value) {
    const text = String(value || '').trim();
    if (!text) return '';
    return `${label}: ${text}`.split('\n').map((line) => (line.trim() ? `  ${line}` : '')).join('\n');
}

function describePersona(persona) {
    const label = String(persona?.label || '').trim();
    return label ? `The user plays ${label}.` : '';
}

/**
 * Activated World Info as text.
 *
 * `before`/`after`, the example block's anchor and the depth entries' `depth`
 * and `role` numbers are all instructions for where core would splice each
 * entry into a native prompt. There is no native prompt here, so they describe
 * nothing about the story and are dropped; the entry text is the content.
 */
function describeLore(lore) {
    const examples = (Array.isArray(lore?.examples) ? lore.examples : [])
        .map((entry) => String(entry?.content ?? entry ?? ''));
    const depth = (Array.isArray(lore?.depth) ? lore.depth : [])
        .flatMap((entry) => (Array.isArray(entry?.entries) ? entry.entries : [entry]))
        .map((entry) => String(entry ?? ''));
    return [lore?.before, ...examples, ...depth, lore?.after]
        .map((part) => String(part || '').trim()).filter(Boolean).join('\n\n');
}

/**
 * What actually changed, in the same `- capability: reason` shape the
 * performer's own receipt injection uses (formatMechanicsReceipts).
 *
 * Applied receipts only. A pending one carries `rejectionReason` and no
 * `reason` — it is a proposal awaiting the user, not a change — and a
 * rolled-back transaction's receipts carry no capability at all. Listing
 * either would tell the Director that something happened which did not.
 */
function describeReceipts(recentReceipts) {
    return (Array.isArray(recentReceipts) ? recentReceipts : [])
        .flatMap((transaction) => (Array.isArray(transaction?.receipts) ? transaction.receipts : []))
        .filter((receipt) => receipt?.status === 'applied' && receipt.capability && receipt.reason)
        .map((receipt) => `- ${receipt.capability}: ${receipt.reason}`)
        .join('\n');
}

/** The accepted history as a transcript. The bulk of this block, by far. */
function describeHistory(history, persona) {
    return (Array.isArray(history) ? history : []).map((message) => {
        const content = String(message?.content || '').trim();
        return content ? `${speakerOf(message, persona)}: ${content}` : '';
    }).filter(Boolean).join('\n\n');
}

/**
 * Nameless messages are real — /sys output, imported logs — and a transcript
 * line has to start with somebody. The role is all that is left to go on.
 */
function speakerOf(message, persona) {
    const name = String(message?.name || '').trim();
    if (name) return name;
    if (message?.role !== 'user') return 'Narrator';
    return String(persona?.label || '').trim() || 'User';
}
