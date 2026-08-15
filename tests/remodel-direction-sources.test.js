import { buildDirectionSources } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/direction-sources.js';

const snapshot = {
    director: { label: 'The Archivist', description: 'Patient.', personality: 'Dry.', scenario: '', creatorNotes: '', systemPrompt: '', postHistoryInstructions: '' },
    mechanics: {
        addressBook: { entries: [{ name: "Aiden's HP", id: 'var-1' }], duplicates: [] },
        serializedVariables: "Aiden's HP: 12 / 20\nMeaning: capacity to withstand injury.",
        goals: [{ title: 'Survive the night', status: 'active' }],
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
    expect(sources.mechanicsSkill).toContain("Aiden's HP");
    expect(sources.mechanicsSkill).not.toMatch(/\bv1\b/);
    expect(sources.mechanicsSkill).not.toMatch(/\bg1\b/);
});

test('the mechanics skill is empty when mechanics are disabled', () => {
    expect(buildDirectionSources(snapshot, { mechanicsEnabled: false }).mechanicsSkill).toBe('');
});

test('the snapshot source carries the current action', () => {
    const sources = buildDirectionSources(snapshot, { mechanicsEnabled: true });
    expect(sources.directorSnapshot).toContain('He swings.');
});

test('a missing director card degrades to empty rather than throwing', () => {
    const sources = buildDirectionSources({ ...snapshot, director: null }, { mechanicsEnabled: false });
    expect(sources.directorCard).toBe('');
});
