import { buildLoomContext } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/loom-context.js';

test('buildLoomContext exposes the mechanical board without a character-card role', () => {
    const sources = buildLoomContext({
        mechanics: {
            serializedVariables: '- Trust: 4',
            goals: [{ ref: 'g1', title: 'Escape', description: 'Leave safely', successRate: 55, status: 'active' }],
            relationships: [],
            authorizedGoalRefs: [],
            capabilities: { 'event.record': { description: 'Record an event', requiredArguments: ['summary'] } },
            addressBook: { duplicates: [] },
        },
    }, { mechanicsEnabled: true });

    expect(sources.mechanicsSkill).toContain('VARIABLES');
    expect(sources.mechanicsSkill).toContain('Trust: 4');
    expect(sources.mechanicsSkill).toContain('Escape');
    expect(sources.mechanicsSkill).toMatch(/materially helps or obstructs/i);
    expect(sources.mechanicsSkill).toContain('goal.edit');
    expect(sources.mechanicsSkill).toMatch(/not an exhaustive whitelist/i);
    expect(sources).not.toHaveProperty('loomCard');
    expect(sources).not.toHaveProperty('loomSnapshot');
});
