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
    // A tracked resolution names its Variable the way every other reference
    // does now — by name.
    expect(sources.mechanicsSkill).toMatch(/Tracks .*Aiden's HP/);
    expect(sources.mechanicsSkill).toContain('Survive the night → Keep the ledger hidden');
    // The Goal the user actually attached this turn.
    expect(sources.mechanicsSkill).toMatch(/ATTEMPTED THIS TURN[\s\S]*Survive the night/);
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

test('the snapshot names the performer and renders lore and applied changes as text', () => {
    const { directorSnapshot } = buildDirectionSources(sceneSnapshot, { mechanicsEnabled: true });
    // By name. The Scene's narratorRef.id is an avatar filename.
    expect(directorSnapshot).toContain('PERFORMER\nSera writes the next response.');
    expect(directorSnapshot).toContain('The user plays Aiden.');
    expect(directorSnapshot).toContain('- Aiden\n  Description: A courier of the Marrow Street guild.');
    // Sera has no personality or scenario text; neither gets an empty label.
    expect(directorSnapshot).not.toContain('Personality: \n');
    expect(directorSnapshot).not.toContain('Scenario: \n');
    // All four lore shapes, including the two that are not strings.
    expect(directorSnapshot).toContain('MARROW STREET GUILD');
    expect(directorSnapshot).toContain('THE FOG');
    expect(directorSnapshot).toContain('<START>\nAiden: "Nine seals."');
    expect(directorSnapshot).toContain('The freight gate has been forced twice this season.');
    // The same `- capability: reason` shape formatMechanicsReceipts uses.
    expect(directorSnapshot).toContain('- variable.adjust: The blow landed before he could turn.');
    // A rolled-back transaction changed nothing, so it is not a recent change.
    expect(directorSnapshot).not.toContain('awaiting user review');
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
    expect(sources.mechanicsSkill).toContain('(none retrieved this turn)');
    expect(sources.mechanicsSkill).toContain('(none active)');
});
