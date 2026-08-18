import { getCapabilityDictionary, REQUIRED_ARGUMENTS } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/mechanics-capabilities.js';
import { buildDirectionSources } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/direction-sources.js';

// Every write the Director attempted was refused for a missing required
// argument — `valueType is required`, `holderRefs is required`, four turns
// running — while those words appeared NOWHERE in the prompt it was refusing.
// The validator and the prompt now read one table, so they cannot disagree
// about what a capability needs.

function mechanicsSkillFor(capabilities) {
    const { mechanicsSkill } = buildDirectionSources(
        { mechanics: { capabilities, goals: [], serializedVariables: '', retrieval: {} } },
        { mechanicsEnabled: true },
    );
    return mechanicsSkill;
}

test('the prompt names every argument the validator will refuse a request for', () => {
    const skill = mechanicsSkillFor(getCapabilityDictionary());

    for (const [capability, required] of Object.entries(REQUIRED_ARGUMENTS)) {
        for (const [key] of required) {
            expect(`${capability} needs ${key}: ${skill.includes(key)}`).toBe(`${capability} needs ${key}: true`);
        }
    }
});

test('the three arguments that actually failed in the field are all present', () => {
    const skill = mechanicsSkillFor(getCapabilityDictionary());

    // From the owner's 2026-08-18T08-31 export, verbatim error strings.
    expect(skill).toContain('valueType');
    expect(skill).toContain('holderRefs');
    expect(skill).toContain('nextState');
});

test('valueType is rendered with its allowed values, not just its name', () => {
    // Naming a required field is not enough if the model cannot guess a legal
    // value for it — an enum is unusable without its members.
    const skill = mechanicsSkillFor(getCapabilityDictionary());

    expect(skill).toMatch(/valueType — .*"number".*"enum".*"text".*"boolean"/);
});

test('the dictionary carries the arguments so the renderer needs no import', () => {
    // direction-sources.js must stay free of anything reaching st-context.js,
    // so the data travels on the snapshot rather than being imported.
    const create = getCapabilityDictionary().find((entry) => entry.name === 'variable.create');

    expect(create.requiredArguments.map((argument) => argument.key)).toEqual(['name', 'valueType', 'value', 'description']);
    for (const argument of create.requiredArguments) {
        expect(typeof argument.hint).toBe('string');
        expect(argument.hint.length).toBeGreaterThan(0);
    }
});

test('a capability with no required arguments renders as a plain line', () => {
    const skill = mechanicsSkillFor([
        { name: 'thing.do', applicableKinds: ['thing'], description: 'Does a thing.', requiredArguments: [] },
    ]);

    expect(skill).toContain('- thing.do (thing): Does a thing.');
    expect(skill).not.toMatch(/thing\.do[\s\S]{0,40}arguments:/);
});

test('a dictionary entry with no requiredArguments field at all does not throw', () => {
    expect(() => mechanicsSkillFor([{ name: 'x.y', applicableKinds: ['x'], description: 'D.' }])).not.toThrow();
});
