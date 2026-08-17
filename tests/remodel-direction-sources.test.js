import { buildDirectionSources } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/direction-sources.js';
import { assignVariableRefs, serializeRetrievedVariables } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/variables-relevance.js';
import { ENTRY_TYPES, parseDirectorReply } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/director-reply.js';
import { addressRequestsByName } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/live-direction.js';
import { buildAddressBook } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/direction-address.js';
import { MECHANICS_PROTOCOL, validateMechanicsRequest, executeMechanicsRequest } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/mechanics-capabilities.js';
import { createVariableValue, getVariableValue } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/variables-store.js';
import { __setExtensionSettings } from './util/st-context-stub.js';

// The Variable lines are built by the REAL producers, not hand-written.
//
// A fixture that spells out the expected shape proves nothing: the previous
// version of this file wrote `"Aiden's HP: 12 / 20"` by hand and asserted the
// result never says `v1`, which passed while production was emitting
// `"[v1] Aiden's HP: 12 / 20"` into the Director's prompt. Driving
// assignVariableRefs -> serializeRetrievedVariables here means these
// assertions fail the moment the prompt starts advertising refs again.
const { listed } = assignVariableRefs([
    {
        variable: {
            id: 'var-1', name: "Aiden's HP", value: '12',
            subvalues: [{ label: 'Maximum', value: 20 }],
            description: 'capacity to withstand injury',
        },
        reasons: ['Directly referenced by the action or a Goal.'],
    },
    {
        variable: { id: 'var-2', name: 'Faction Heat', value: '3', subvalues: [], description: '' },
        reasons: [],
    },
]);

const snapshot = {
    director: { label: 'The Archivist', description: 'Patient.', personality: 'Dry.', scenario: '', creatorNotes: '', systemPrompt: '', postHistoryInstructions: '' },
    mechanics: {
        addressBook: { entries: [{ name: "Aiden's HP", id: 'var-1' }, { name: 'Faction Heat', id: 'var-2' }], duplicates: [] },
        serializedVariables: serializeRetrievedVariables(listed),
        capabilities: [{ name: 'variable.adjust', applicableKinds: ['number'], description: 'Change a numeric Variable by a delta.' }],
        goals: [{
            ref: 'g1', title: 'Survive the night', description: 'Reach dawn alive.', status: 'active',
            visibility: 'public', successRate: 45,
            holderRefs: [{ kind: 'persona', id: 'persona-1', label: 'Aiden' }],
            targetRefs: [],
            resolution: { kind: 'tracked', variableName: "Aiden's HP", field: 'value', direction: 'decrease', completionThreshold: 0 },
        }, {
            ref: 'g2', title: 'Keep the ledger hidden', description: '', status: 'background',
            visibility: 'secret', successRate: 70, holderRefs: [], targetRefs: [], resolution: { kind: 'instant' },
        }],
        relationships: [{ fromRef: 'g1', toRef: 'g2', type: 'antagonistic', reason: 'Bleeding out is loud.' }],
        authorizedGoalRefs: ['g1'],
        retrieval: { degraded: false, warning: '', selected: 2 },
    },
    currentAction: 'He swings.',
};

test('the protocol source states the reply contract without pacing policy', () => {
    const sources = buildDirectionSources(snapshot, { mechanicsEnabled: false });
    expect(sources.directionProtocol).toMatch(/instruction/i);
    expect(sources.directionProtocol).not.toMatch(/responses may be long/i);
    expect(sources.directionProtocol).not.toMatch(/world may move/i);
});

// ENTRY_TYPES, not a hardcoded ['note', 'ruling', 'result', 'secret'] copy: the
// parser's tag vocabulary is the single source of truth. A literal copy here
// could drift from it silently — this way, if director-reply.js ever adds or
// renames a type, this test fails until the protocol text is updated to match.
test('the protocol teaches every tag the parser recognises, and only those', () => {
    const { directionProtocol } = buildDirectionSources(snapshot, { mechanicsEnabled: true });
    for (const type of ENTRY_TYPES) expect(directionProtocol).toContain(`[${type}]`);
});

// Review I4. This is ledger Finding 2's shape one level down: the tag NAMES
// were pinned to ENTRY_TYPES above, but the SEMANTICS the protocol teaches
// about them were free to drift, and they had. The protocol promised "A line
// with no tag is read as a note"; `readEntries` appends an untagged line to
// the PREVIOUS entry and only makes a note of untagged prose that leads the
// reply. A Director following the old sentence would write colour under a
// `[secret]` expecting it to reach the performer, and it was withheld.
//
// Both halves are executed against the real parser rather than merely asserted
// about the prose, so this fails if EITHER side moves.
test('the protocol describes the untagged-line rule the parser actually implements', () => {
    const { directionProtocol } = buildDirectionSources(snapshot, { mechanicsEnabled: true });
    // The wrong promise, verbatim as it shipped.
    expect(directionProtocol).not.toMatch(/a line with no tag is read as a note/i);
    expect(directionProtocol).toMatch(/continues the entry above it/i);
    expect(parseDirectorReply('[secret] Hidden.\nStill hidden.').entries)
        .toEqual([{ type: 'secret', text: 'Hidden.\nStill hidden.' }]);
    expect(parseDirectorReply('Colour before any tag.\n[note] Tagged.').entries[0])
        .toEqual({ type: 'note', text: 'Colour before any tag.' });
});

// --- the Director's own notebook (review I5) --------------------------------
//
// The notebook was write-only from its author's side: entries reached the
// Narrator (filtered) and the owner's panel, and nothing fed them back to the
// Director. A `[secret]` therefore reached NOBODY on the next turn, so a
// hidden twist could not survive one turn — in a design whose decision table
// promises "an active member with a persistent notebook".
//
// `directorNotebook` is the one function-form source: compilePromptRecipe
// calls it with the block's own `settings`, which is how a per-block depth
// reaches a source without becoming part of what is sent.

const notebookEntries = [
    { turn: 1, type: 'note', text: 'The rain has not let up.' },
    { turn: 2, type: 'ruling', text: 'Teo answers once Eli sits.' },
    { turn: 2, type: 'secret', text: 'The boy already knows she will.' },
    { turn: 3, type: 'result', text: 'Eli sat.' },
];

function notebookSource(entries, settings) {
    return buildDirectionSources({ ...snapshot, notebook: entries }, { mechanicsEnabled: true })
        .directorNotebook(settings);
}

test("the Director's notebook source is a function that reads the block's own depth", () => {
    // Not a string. If it were, the depth setting could not reach it and the
    // source would be as inert as the control that used to configure it.
    const { directorNotebook } = buildDirectionSources(snapshot, { mechanicsEnabled: true });
    expect(typeof directorNotebook).toBe('function');
});

test('the Director sees its own secrets, which is the whole point of feeding the notebook back', () => {
    const text = notebookSource(notebookEntries, { depth: 3 });
    expect(text).toContain('The boy already knows she will.');
    // Labelled as what it is, so the Director knows the performer never saw it
    // and can still choose to reveal it in a later ruling.
    expect(text).toMatch(/Secret, never shown to the performer: The boy already knows she will\./);
});

test('depth counts turns, oldest first, so the newest turn lands closest to the request', () => {
    const narrow = notebookSource(notebookEntries, { depth: 1 });
    expect(narrow).toContain('Eli sat.');
    expect(narrow).not.toContain('Teo answers once Eli sits.');
    expect(narrow).not.toContain('The rain has not let up.');

    const wide = notebookSource(notebookEntries, { depth: 2 });
    // Ordering, not just membership: a turn later in the fiction must appear
    // later in the text.
    expect(wide.indexOf('Teo answers once Eli sits.')).toBeLessThan(wide.indexOf('Eli sat.'));
    expect(wide).not.toContain('The rain has not let up.');
});

test("a cancelled take's entries are withheld from the Director too, and do not consume a depth slot", () => {
    // Same asymmetry readNarratorEntries applies, for the same reason: a
    // secret's turn happened, so it sits inside the window; a cancelled take
    // did not happen at all, so it is removed before the window is counted —
    // otherwise it would push a real turn out of view while contributing
    // nothing in its place.
    const withCancelled = [
        { turn: 1, type: 'ruling', text: 'The oldest real turn.' },
        { turn: 2, type: 'ruling', text: 'A take the user stopped.', abandoned: true },
        { turn: 3, type: 'ruling', text: 'The newest real turn.' },
    ];
    const text = notebookSource(withCancelled, { depth: 2 });
    expect(text).toContain('The oldest real turn.');
    expect(text).toContain('The newest real turn.');
    expect(text).not.toContain('A take the user stopped.');
});

test('an empty notebook renders nothing rather than an empty heading', () => {
    expect(notebookSource([], { depth: 3 })).toBe('');
    expect(notebookSource(undefined, { depth: 3 })).toBe('');
});

test('a missing depth renders nothing rather than dumping the whole notebook into the prompt', () => {
    // The recipe normaliser always fills a declared setting, so an absent
    // depth means a caller outside the recipe path. Rendering an unbounded
    // notebook there is the worse of the two answers.
    expect(notebookSource(notebookEntries, {})).toBe('');
    expect(notebookSource(notebookEntries, undefined)).toBe('');
});

test('the notebook is not rendered into the Scene Snapshot, which picks its fields explicitly', () => {
    // The separation the secret guarantee rests on: this text is a
    // director-mode source and nothing else. A snapshot that rendered it would
    // put secrets into a block the Narrator preview also compiles.
    const { directorSnapshot } = buildDirectionSources({ ...snapshot, notebook: notebookEntries }, { mechanicsEnabled: true });
    expect(directorSnapshot).not.toContain('The boy already knows she will.');
    expect(directorSnapshot).not.toContain('Teo answers once Eli sits.');
});

test('the protocol carries no pacing, autonomy or style policy', () => {
    const { directionProtocol } = buildDirectionSources(snapshot, { mechanicsEnabled: true });
    expect(directionProtocol).not.toMatch(/pacing|rhythm|opening|breath|length/i);
});

/**
 * The property that matters most here: text the protocol tells the Director
 * to write is text the REAL capability layer accepts and applies — not just
 * text the parser reads back into a `requests` array. A contract that
 * documents a shape `parseDirectorReply` happily returns but
 * `validateMechanicsRequest`/`executeMechanicsRequest` reject is exactly the
 * failure this task exists to prevent (it happened twice on this exact
 * example: first with `name`/`amount` instead of `variableRef`/`delta`, then
 * with those fields flattened onto the request instead of nested under
 * `arguments` alongside the missing `id`/`reason`), so this test carries the
 * documented example through the whole pipeline the Director's real reply
 * goes through: parse -> validate -> resolve names -> execute -> real store
 * mutation.
 *
 * The example is sliced out of the live `directionProtocol` string (from its
 * first tag to the end), not retyped, so a change to the protocol's own tag
 * block or fence is what this test exercises — never a hand-maintained copy
 * that could drift from it.
 */
test("the protocol's own documented example round-trips through the real parser and the real capability layer", () => {
    __setExtensionSettings({});
    const timelineId = 'timeline-protocol-example';
    const moraleId = createVariableValue({
        timelineId, name: 'Morale', valueType: 'number', value: 5,
        description: 'group spirits', authority: 'world', retrieval: { mode: 'always' },
    }).id;

    const { directionProtocol } = buildDirectionSources(snapshot, { mechanicsEnabled: true });
    const example = directionProtocol.slice(directionProtocol.indexOf('[note]'));
    const { entries, state, tailFound, tailError } = parseDirectorReply(example);

    // One entry per tag, in the order the protocol lists them — proves every
    // tag the protocol teaches is one the parser actually recognises.
    expect(entries.map((entry) => entry.type)).toEqual(['note', 'ruling', 'result', 'secret']);
    expect(entries[0].text).toContain('observation, colour, what is in the air');
    expect(entries[1].text).toContain('a decision that binds the next response');
    expect(entries[2].text).toContain('what actually happened, for the record');
    expect(entries[3].text).toContain('never shown to the performer');

    // The fence the protocol documents as "close with a single fenced state
    // block" parses as the state tail it claims, with no error.
    expect(tailFound).toBe(true);
    expect(tailError).toBe('');
    // Shape, not just field names: id/capability/arguments/reason are all
    // top-level, and variableRef/delta live nested inside `arguments` —
    // exactly what validateMechanicsRequest (mechanics-capabilities.js)
    // requires and addressRequestsByName (live-direction.js) reads. The
    // model never emits `protocol`; that is a constant the caller supplies.
    expect(state.requests).toEqual([{
        id: 'r1', capability: 'variable.adjust',
        arguments: { variableRef: 'Morale', delta: -1 },
        reason: 'the in-fiction reason this happened, one sentence',
    }]);
    expect(state.flow.continue).toBe(false);

    // Structurally valid by the same rules real execution enforces — not an
    // assumption, a call to the real validator.
    const validation = validateMechanicsRequest({ protocol: MECHANICS_PROTOCOL, requests: state.requests });
    expect(validation.errors).toEqual([]);
    expect(validation.valid).toBe(true);

    // And it actually runs: name resolves against a real address book, and
    // execution actually moves the real Variable it names.
    const book = buildAddressBook([{ id: moraleId, name: 'Morale' }]);
    const { variableRefs, unresolvedReasons } = addressRequestsByName(state.requests, book, new Map(), new Map());
    expect(unresolvedReasons).toEqual([]);
    expect(variableRefs.get('Morale')).toBe(moraleId);

    const result = executeMechanicsRequest(
        { protocol: MECHANICS_PROTOCOL, requests: state.requests },
        { timelineId, sceneId: 'scene-protocol-example', variableRefs, goalRefs: new Map() },
    );
    expect(result.ok).toBe(true);
    expect(result.receipts[0].status).toBe('applied');
    expect(getVariableValue(moraleId, timelineId).value).toBe(4);
});

test('the card source carries the Director card material', () => {
    const sources = buildDirectionSources(snapshot, { mechanicsEnabled: false });
    expect(sources.directorCard).toContain('The Archivist');
    expect(sources.directorCard).toContain('Patient.');
});

test('the mechanics skill names Variables by name and never by ref', () => {
    const sources = buildDirectionSources(snapshot, { mechanicsEnabled: true });
    // The exact line the real serializer produced, not a paraphrase of it.
    expect(sources.mechanicsSkill).toContain("Aiden's HP: 12");
    expect(sources.mechanicsSkill).toContain('Faction Heat: 3');
    expect(sources.mechanicsSkill).not.toMatch(/\bv1\b/);
    expect(sources.mechanicsSkill).not.toMatch(/\bv2\b/);
    expect(sources.mechanicsSkill).not.toMatch(/\bg1\b/);
    expect(sources.mechanicsSkill).not.toMatch(/\bg2\b/);
});

test('the mechanics skill carries the Goal state the Director is asked to move', () => {
    const sources = buildDirectionSources(snapshot, { mechanicsEnabled: true });
    // goal.shift moves successRate, so a Director that cannot read it is
    // shifting a number it has never seen.
    expect(sources.mechanicsSkill).toContain('45%');
    expect(sources.mechanicsSkill).toContain('Reach dawn alive.');
    expect(sources.mechanicsSkill).toContain('secret');
    expect(sources.mechanicsSkill).toContain('Survive the night → Keep the ledger hidden');
    // The Goal the user actually attached this turn.
    expect(sources.mechanicsSkill).toMatch(/ATTEMPTED THIS TURN[\s\S]*Survive the night/);
});

test('the Director is given rate reference points to reason from, not a table to pick from', () => {
    // The seven bands and four magnitudes used to be lookup tables in
    // story-goals-math.js, and goal.shift accepted only the four words — so the
    // Director could not say how far a Goal had actually moved. The numbers are
    // guidance now; the Director states the rate.
    const { mechanicsSkill } = buildDirectionSources(snapshot, { mechanicsEnabled: true });
    expect(mechanicsSkill).toMatch(/\b5\b/);
    expect(mechanicsSkill).toMatch(/\b95\b/);
    expect(mechanicsSkill).toMatch(/nearly assured/i);
});

test('the guidance says code owns the roll and the result binds', () => {
    const { mechanicsSkill } = buildDirectionSources(snapshot, { mechanicsEnabled: true });
    expect(mechanicsSkill).toMatch(/code rolls/i);
});

test('the guidance carries no pacing or style policy', () => {
    // That belongs to the owner's own recipe. Mixing authorial policy into the
    // block the Director badge contributes is the problem the whole rework
    // exists to end — the Director's prompt used to be a hardcoded template
    // literal blending protocol with taste.
    const { mechanicsSkill } = buildDirectionSources(snapshot, { mechanicsEnabled: true });
    expect(mechanicsSkill).not.toMatch(/pacing|rhythm|breath|prose style|tone of the/i);
});

test('rate guidance is omitted when there are no Goals to rate', () => {
    const bare = { ...snapshot, mechanics: { ...snapshot.mechanics, goals: [] } };
    expect(buildDirectionSources(bare, { mechanicsEnabled: true }).mechanicsSkill).not.toMatch(/nearly assured/i);
});

test('the capability dictionary is rendered, and its heading is omitted when there is none', () => {
    expect(buildDirectionSources(snapshot, { mechanicsEnabled: true }).mechanicsSkill).toContain('variable.adjust');
    const bare = { ...snapshot, mechanics: { ...snapshot.mechanics, capabilities: [] } };
    expect(buildDirectionSources(bare, { mechanicsEnabled: true }).mechanicsSkill).not.toContain('CAPABILITIES');
});

test('mechanics being disabled says so instead of silently deleting Variables and Goals', () => {
    const sources = buildDirectionSources(snapshot, { mechanicsEnabled: false });
    // The state still exists and the Director still needs to read it; what is
    // gone is its ability to change it. Saying nothing left the Director with
    // no Variables, no Goals, and a required `requests` array to fill.
    expect(sources.mechanicsSkill).toContain("Aiden's HP: 12");
    expect(sources.mechanicsSkill).toContain('Survive the night');
    expect(sources.mechanicsSkill).not.toContain('CAPABILITIES');
    expect(sources.mechanicsSkill).toMatch(/read-only/i);
    expect(sources.mechanicsSkill).toMatch(/empty/i);
});

test('a degraded retrieval says what degraded, without quoting the transport error', () => {
    const degraded = {
        ...snapshot,
        mechanics: {
            ...snapshot.mechanics,
            retrieval: { degraded: true, warning: 'Failed to parse URL from /api/vector/list', selected: 2 },
        },
    };
    const sources = buildDirectionSources(degraded, { mechanicsEnabled: true });
    expect(sources.mechanicsSkill).toMatch(/Semantic retrieval was unavailable/i);
    // Raw internal error text belongs in the journal, where it is debuggable —
    // not in the prompt, where the model has to parse machine noise it cannot
    // act on. This exact string was observed reaching the Director.
    expect(sources.mechanicsSkill).not.toContain('/api/vector/list');
    expect(sources.mechanicsSkill).not.toMatch(/failed to parse/i);
    // And a healthy retrieval says nothing at all.
    expect(buildDirectionSources(snapshot, { mechanicsEnabled: true }).mechanicsSkill)
        .not.toMatch(/semantic retrieval/i);
});

test('the snapshot source carries the current action', () => {
    const sources = buildDirectionSources(snapshot, { mechanicsEnabled: true });
    expect(sources.directorSnapshot).toContain('He swings.');
});

// The Scene snapshot, in the shape buildDirectionSnapshot (live-direction.js)
// actually returns — not a shape convenient to assert against.
//
// Every identifier here is the real kind the running app produces: createId's
// `<prefix>-<uuid>` for the Scene and Timeline, avatar filenames for cast and
// persona refs, and the integer chat indices buildDirectionSnapshot stamps
// onto each accepted message. `lore` carries core's real World Info shapes —
// EMEntries as `{ position, content }` and WIDepthEntries as
// `{ depth, entries[], role }` — not strings. `recentReceipts` carries what
// scrubReceipt leaves behind, including the statuses.
//
// The ids matter: the no-identifier assertion below is only worth anything if
// there are real ids in the input for it to fail on.
const sceneSnapshot = {
    scene: {
        id: 'scene-4f2a1c9e-8b17-4d0a-9c33-6ee0a1b25d47',
        timelineId: 'timeline-2c9d7ab4-51e6-4f8b-a0c1-9d3e5f7b8a20',
        title: 'The Ninth Seal',
    },
    currentAction: 'He steps between her and the crate and puts one hand flat on the lid.',
    cast: [
        { ref: { kind: 'character', id: 'Aiden.png', label: 'Aiden' }, label: 'Aiden', description: 'A courier of the Marrow Street guild.', personality: 'Dry, watchful.', scenario: 'Waiting in a fog-bound loading bay.' },
        { ref: { kind: 'character', id: 'Sera.png', label: 'Sera' }, label: 'Sera', description: 'A fixer who has outlived two employers.', personality: '', scenario: '' },
    ],
    director: snapshot.director,
    narratorRef: { kind: 'narrator', id: 'Sera.png', label: 'Sera' },
    persona: { kind: 'persona', id: 'user-default.png', label: 'Aiden' },
    acceptedHistory: [
        { id: 112, role: 'user', name: 'Aiden', content: 'He counts the seals again.\n\nNine, the way there were nine at the depot.' },
        { id: 113, role: 'assistant', name: 'Sera', content: '"You counted them," she said.' },
        { id: 114, role: 'assistant', name: '', content: 'The freight gate rolls back on its track.' },
        { id: 115, role: 'user', name: '', content: 'He does not move.' },
    ],
    lore: {
        before: 'MARROW STREET GUILD: couriers bonded to the seals they carry, not to a house.',
        after: 'THE FOG: sound carries; sight does not.',
        examples: [{ position: 0, content: '<START>\nAiden: "Nine seals."' }],
        depth: [{ depth: 4, entries: ['The freight gate has been forced twice this season.'], role: 0 }],
    },
    mechanics: snapshot.mechanics,
    recentReceipts: [
        {
            status: 'applied',
            receipts: [{
                requestId: 'req-a41f', capability: 'variable.adjust', status: 'applied', approvalStatus: 'authorized',
                reason: 'The blow landed before he could turn.',
                validatedInputs: { variableRef: 'v1', delta: -3 },
                before: { name: "Aiden's HP", value: 15 }, after: { name: "Aiden's HP", value: 12 },
            }],
        },
        {
            status: 'rolled-back',
            receipts: [{ status: 'rejected', rejectionReason: 'An applied operation depends on a proposal awaiting user review.' }],
        },
    ],
};

test('the snapshot source emits no identifier of any kind', () => {
    const { directorSnapshot } = buildDirectionSources(sceneSnapshot, { mechanicsEnabled: true });
    // The reply envelope has no field that takes one, and requests address
    // Variables and Goals by name — so an id here is an address the Director
    // cannot use and might echo. Asserted as shapes over the whole block, so
    // reintroducing any of them anywhere fails this.
    expect(directorSnapshot).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    expect(directorSnapshot).not.toMatch(/\b(scene|timeline|req|tx|direction|turn|checkpoint)-[0-9a-f]/i);
    expect(directorSnapshot).not.toMatch(/\.(png|jpe?g|webp|gif)\b/i);
    // Message ids are bare integers, so there is no shape to match — assert on
    // the actual values the fixture carries.
    for (const message of sceneSnapshot.acceptedHistory) {
        expect(directorSnapshot).not.toMatch(new RegExp(`\\b${message.id}\\b`));
    }
});

test('accepted history renders as dialogue, not as JSON records', () => {
    const { directorSnapshot } = buildDirectionSources(sceneSnapshot, { mechanicsEnabled: true });
    expect(directorSnapshot).toContain('Aiden: He counts the seals again.');
    expect(directorSnapshot).toContain('Sera: "You counted them," she said.');
    // One blank line between messages, so the second paragraph of a message is
    // not read as a new speaker's turn.
    expect(directorSnapshot).toContain('nine at the depot.\n\nSera: "You counted them,');
    // A nameless message still needs a speaker; its role supplies one.
    expect(directorSnapshot).toContain('Narrator: The freight gate rolls back on its track.');
    expect(directorSnapshot).toContain('Aiden: He does not move.');
    // Nothing transport-shaped survives: no field names, no braces around
    // quoted keys, and no escaped newlines standing in for paragraph breaks.
    expect(directorSnapshot).not.toContain('"role"');
    expect(directorSnapshot).not.toContain('"content"');
    expect(directorSnapshot).not.toContain('"name"');
    expect(directorSnapshot).not.toMatch(/\{"|"\}/);
    expect(directorSnapshot).not.toContain('\\n');
});

test('a section with nothing in it is omitted, not rendered as a bare heading', () => {
    const bare = {
        ...sceneSnapshot,
        scene: { ...sceneSnapshot.scene, title: '' },
        cast: [],
        narratorRef: null,
        persona: null,
        acceptedHistory: [],
        lore: { before: '', after: '', examples: [], depth: [] },
        recentReceipts: [],
    };
    const { directorSnapshot } = buildDirectionSources(bare, { mechanicsEnabled: true });
    for (const heading of ['SCENE', 'PERFORMER', 'CAST', 'PERSONA', 'LORE', 'RECENT CHANGES', 'STORY SO FAR']) {
        expect(directorSnapshot).not.toContain(heading);
    }
    // Exactly the one section that still has something in it, and nothing else
    // — no stray separators from the sections that dropped out.
    expect(directorSnapshot).toBe(`CURRENT ACTION\n${bare.currentAction}`);
});

test('the snapshot names the performer and renders applied changes as text', () => {
    const { directorSnapshot } = buildDirectionSources(sceneSnapshot, { mechanicsEnabled: true });
    // By name. The Scene's narratorRef.id is an avatar filename.
    expect(directorSnapshot).toContain('PERFORMER\nSera writes the next response.');
    expect(directorSnapshot).toContain('The user plays Aiden.');
    expect(directorSnapshot).toContain('- Aiden\n  Description: A courier of the Marrow Street guild.');
    // Sera has no personality or scenario text; neither gets an empty label.
    expect(directorSnapshot).not.toContain('Personality: \n');
    expect(directorSnapshot).not.toContain('Scenario: \n');
    // World Info is four blocks of its own now. Rendering it here as well
    // would send every activated entry twice - once from its block and once
    // inside this locked one.
    expect(directorSnapshot).not.toContain('MARROW STREET GUILD');
    expect(directorSnapshot).not.toContain('LORE');
    // The same `- capability: reason` shape formatMechanicsReceipts uses.
    expect(directorSnapshot).toContain('- variable.adjust: The blow landed before he could turn.');
    // A rolled-back transaction changed nothing, so it is not a recent change.
    expect(directorSnapshot).not.toContain('awaiting user review');
});

test('World Info reaches the Director as four separately addressable sources', () => {
    const sources = buildDirectionSources(sceneSnapshot, { mechanicsEnabled: true });

    // All four lore shapes, including the two that are not strings, each in
    // its own block so a recipe can move it, disable it, or place it against
    // the notebook - which is what the Roleplay recipe could always do.
    expect(sources.worldInfoBefore).toContain('MARROW STREET GUILD');
    expect(sources.worldInfoAfter).toContain('THE FOG');
    expect(sources.worldInfoExamples).toContain('<START>\nAiden: "Nine seals."');
    expect(sources.worldInfoDepth).toContain('The freight gate has been forced twice this season.');

    // And they do not bleed into each other: disabling one block has to
    // actually withhold that content, which it cannot do if another carries it.
    expect(sources.worldInfoBefore).not.toContain('THE FOG');
    expect(sources.worldInfoAfter).not.toContain('MARROW STREET GUILD');
});

test('a Timeline with no lore yields empty sources rather than empty headings', () => {
    const sources = buildDirectionSources({ ...sceneSnapshot, lore: null }, { mechanicsEnabled: true });

    // compilePromptRecipe drops an empty source, so empty here means the block
    // contributes no message at all - never a bare heading with nothing under it.
    expect(sources.worldInfoBefore).toBe('');
    expect(sources.worldInfoAfter).toBe('');
    expect(sources.worldInfoExamples).toBe('');
    expect(sources.worldInfoDepth).toBe('');
});

test('the current action is the last thing the Director reads', () => {
    const { directorSnapshot } = buildDirectionSources(sceneSnapshot, { mechanicsEnabled: true });
    // It is the newest information in the block and the only line not already
    // somewhere in the history above it — the user's message is not written to
    // the chat until after the direction pass returns.
    expect(directorSnapshot.endsWith(`CURRENT ACTION\n${sceneSnapshot.currentAction}`)).toBe(true);
    expect(directorSnapshot.indexOf('CURRENT ACTION')).toBeGreaterThan(directorSnapshot.indexOf('STORY SO FAR'));
});

test('a missing director card degrades to empty rather than throwing', () => {
    const sources = buildDirectionSources({ ...snapshot, director: null }, { mechanicsEnabled: false });
    expect(sources.directorCard).toBe('');
});

test('a snapshot with no mechanics at all still renders', () => {
    const sources = buildDirectionSources({ currentAction: 'He waits.' }, { mechanicsEnabled: true });
    expect(sources.mechanicsSkill).toMatch(/VARIABLES/);
    expect(sources.mechanicsSkill).toMatch(/GOALS/);
    // No `retrieval` block at all, so nothing says this Scene has never had a
    // Goal. Falling through to the invitation would be a claim the snapshot
    // does not support; "none were relevant" is the honest reading.
    expect(sources.mechanicsSkill).toMatch(/were relevant this turn/i);
    expect(sources.mechanicsSkill).not.toContain('goal.create');
});

test('a Scene holding no Goals is told so, and invited to write one', () => {
    const empty = { ...snapshot, mechanics: { ...snapshot.mechanics, goals: [], retrieval: { goalsEmptyCode: 'none-authored' } } };
    const { mechanicsSkill } = buildDirectionSources(empty, { mechanicsEnabled: true });

    expect(mechanicsSkill).toMatch(/No Goals are open in this Scene/i);
    expect(mechanicsSkill).toContain('goal.create');
});

test('a Scene whose Goals simply did not surface is not invited to invent one', () => {
    const empty = { ...snapshot, mechanics: { ...snapshot.mechanics, goals: [], retrieval: { goalsEmptyCode: 'none-matched' } } };
    const { mechanicsSkill } = buildDirectionSources(empty, { mechanicsEnabled: true });

    expect(mechanicsSkill).toMatch(/None of this Scene's Goals were relevant/i);
    expect(mechanicsSkill).not.toContain('goal.create');
});

test('the Goal invitation is withheld when mechanics are off, because no request would be legal', () => {
    const empty = { ...snapshot, mechanics: { ...snapshot.mechanics, goals: [], retrieval: { goalsEmptyCode: 'none-authored' } } };
    const { mechanicsSkill } = buildDirectionSources(empty, { mechanicsEnabled: false });

    expect(mechanicsSkill).toMatch(/No Goals are open in this Scene/i);
    expect(mechanicsSkill).not.toContain('goal.create');
});

test('a Timeline holding no Variables is told so, and invited to make one', () => {
    // "No relevant Variables were retrieved" says some exist and none matched.
    // On a Timeline with zero it is untrue, and paired with the protocol's
    // "if, and only if, anything mechanical changed" it reads as licence to do
    // nothing — which is what the owner observed: a whole session of
    // tailFound: false with variable.create never used.
    const empty = { ...snapshot, mechanics: { ...snapshot.mechanics, serializedVariables: '', retrieval: { emptyCode: 'none-authored' } } };
    const { mechanicsSkill } = buildDirectionSources(empty, { mechanicsEnabled: true });

    expect(mechanicsSkill).toMatch(/no Variables yet/i);
    expect(mechanicsSkill).toContain('variable.create');
});

test('a Timeline whose Variables simply did not match is not invited to invent one', () => {
    const empty = { ...snapshot, mechanics: { ...snapshot.mechanics, serializedVariables: '', retrieval: { emptyCode: 'none-matched' } } };
    const { mechanicsSkill } = buildDirectionSources(empty, { mechanicsEnabled: true });

    expect(mechanicsSkill).toMatch(/were relevant this turn/i);
    expect(mechanicsSkill).not.toMatch(/create it with variable\.create/i);
});

test('with mechanics off the empty Timeline gets no invitation it could not act on', () => {
    // Mechanics disabled means the Director must return no requests at all, so
    // inviting one would be a trap.
    const empty = { ...snapshot, mechanics: { ...snapshot.mechanics, serializedVariables: '', retrieval: { emptyCode: 'none-authored' } } };
    const { mechanicsSkill } = buildDirectionSources(empty, { mechanicsEnabled: false });

    expect(mechanicsSkill).toMatch(/no Variables yet/i);
    expect(mechanicsSkill).not.toMatch(/variable\.create/i);
});

// --- the interruption -------------------------------------------------------
//
// The user cuts into a performance mid-sentence. Two facts have to reach the
// Director and they pull in opposite directions: the part that was READ is
// fiction and stands (so the beat must not be re-issued from the beginning),
// and the part that was NOT read is nothing at all (so it must never be
// referred to as having happened). Getting the second one wrong is the worse
// failure and the invisible one — the scene starts calling back to events the
// user never saw a word of, and there is nothing on screen to tell them why.
//
// These are assertions on the exact prose, because the prose is the whole
// feature. live-direction.js decides WHEN an interruption exists; this module
// decides what it SAYS, and the two are tested apart on purpose.

/** A cut mid-clause: the grab reached the user, the drag did not. */
const interruptedSnapshot = {
    ...sceneSnapshot,
    acceptedHistory: [
        { id: 112, role: 'user', name: 'Aiden', content: 'He steps into the bay.' },
        { id: 113, role: 'assistant', name: 'Sera', content: 'Someone takes him by the collar', interrupted: true },
    ],
    interruption: {
        performer: 'Sera',
        acceptedLength: 31,
        unspokenRemainder: 'and drags him toward the freight gate before he can plant his feet.',
    },
    currentAction: '"Hey —"',
};

test('an interrupted turn tells the Director where the reading stopped and not to start the beat over', () => {
    const { directorSnapshot } = buildDirectionSources(interruptedSnapshot, { mechanicsEnabled: true });
    const section = directorSnapshot.slice(directorSnapshot.indexOf('THE INTERRUPTION'), directorSnapshot.indexOf('CURRENT ACTION'));

    expect(section).toContain('Sera was still delivering the last response in STORY SO FAR when the user cut in.');
    // How far it got, in the one unit that is unambiguous. Without this the
    // Director can see that a line ended early but not whether it ended after
    // a clause or after a syllable.
    expect(section).toContain('31 in');
    // The read half IS fiction and stands…
    expect(section).toMatch(/read, so it is fiction and it stands/);
    // …and this is the sentence that actually stops the restart the owner
    // reported. "You were interrupted" alone leaves "so give that beat again"
    // as a perfectly reasonable reading of it.
    expect(section).toMatch(/already been delivered, so do not direct it to be given again from the beginning/);
});

test('the unspoken remainder is handed over as an intention and never as an event', () => {
    const { directorSnapshot } = buildDirectionSources(interruptedSnapshot, { mechanicsEnabled: true });
    const section = directorSnapshot.slice(directorSnapshot.indexOf('THE INTERRUPTION'), directorSnapshot.indexOf('CURRENT ACTION'));

    // Preserved in full, and quoted rather than narrated: a quotation is
    // plainly something said-or-not, where a paraphrase blends into the record
    // around it.
    expect(section).toContain('"and drags him toward the freight gate before he can plant his feet."');
    expect(section).toContain('which never reached the user');
    // The three denials that keep it out of the fiction, each of them load
    // bearing: not an event, nothing established, nobody in the scene knows.
    expect(section).toContain('Treat that as an unspoken intention, not as an event.');
    expect(section).toContain('None of it has happened, none of it is established, and nobody in the scene has seen or heard it.');
    expect(section).toMatch(/Never refer to it.*as something that occurred/);
    // And the decision is explicitly the Director's, with all three outcomes
    // named — otherwise "do not treat it as fact" reads as "discard it".
    expect(section).toMatch(/all of it, some of it later, or none of it/);
});

test('the interrupted line is marked where it was cut, inside the transcript itself', () => {
    const { directorSnapshot } = buildDirectionSources(interruptedSnapshot, { mechanicsEnabled: true });
    // A transcript line that simply stops mid-clause is indistinguishable from
    // a performer that had little to say. The note sits under the line it is
    // about, not beside the speaker.
    expect(directorSnapshot).toContain('Sera: Someone takes him by the collar\n[The user cut in here. Nothing past this point was ever shown to them.]');
    // Only the turn that was cut. The user's own line above it is untouched.
    expect(directorSnapshot).toContain('Aiden: He steps into the bay.\n\nSera:');
    expect(directorSnapshot.split('The user cut in here').length - 1).toBe(1);
});

test('an interruption at character zero is not reported as a beat cut short', () => {
    // The distinction the design turns on. At zero nothing was read, so nothing
    // became fiction and there is no half-delivered beat to direct around;
    // telling the Director one was cut short invites it to write around
    // something the user never saw. Mid-sentence is the opposite case, and the
    // two must not arrive as one undifferentiated flag.
    const { directorSnapshot } = buildDirectionSources({
        ...interruptedSnapshot,
        acceptedHistory: [{ id: 112, role: 'user', name: 'Aiden', content: 'He steps into the bay.' }],
        interruption: { performer: 'Sera', acceptedLength: 0, unspokenRemainder: 'and drags him toward the freight gate.' },
    }, { mechanicsEnabled: true });

    expect(directorSnapshot).not.toContain('THE INTERRUPTION');
    // The remainder goes with it. A remainder with no read half in front of it
    // is a whole beat nobody saw, offered to the Director as though a slice of
    // it had landed.
    expect(directorSnapshot).not.toContain('drags him toward the freight gate');
    expect(directorSnapshot).not.toContain('cut in');
});

test('a turn cut with nothing left in the buffer says so rather than quoting an empty remainder', () => {
    const { directorSnapshot } = buildDirectionSources({
        ...interruptedSnapshot,
        interruption: { performer: 'Sera', acceptedLength: 31, unspokenRemainder: '' },
    }, { mechanicsEnabled: true });
    const section = directorSnapshot.slice(directorSnapshot.indexOf('THE INTERRUPTION'), directorSnapshot.indexOf('CURRENT ACTION'));

    expect(section).toContain('Nothing further had been written when the cut landed');
    // No empty quotation, and no invitation to rule on a remainder there is
    // none of.
    expect(section).not.toContain('""');
    expect(section).not.toContain('Ruling on it is yours');
});

test('an ordinary turn carries no interruption section at all', () => {
    // sceneSnapshot has no `interruption` field and no interrupted history
    // entry, which is every turn nobody cut into.
    const { directorSnapshot } = buildDirectionSources(sceneSnapshot, { mechanicsEnabled: true });
    expect(directorSnapshot).not.toContain('THE INTERRUPTION');
    expect(directorSnapshot).not.toContain('cut in');
});
