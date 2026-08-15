import { buildDirectionSources } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/direction-sources.js';
import { assignVariableRefs, serializeRetrievedVariables } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/variables-relevance.js';

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

test('the snapshot source carries the current action', () => {
    const sources = buildDirectionSources(snapshot, { mechanicsEnabled: true });
    expect(sources.directorSnapshot).toContain('He swings.');
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
