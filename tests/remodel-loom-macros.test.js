import { __setExtensionSettings } from './util/st-context-stub.js';
import {
    renderLoomAction, renderLoomGoals, renderLoomVariables,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/narrator-prompt.js';
import { createTimelineGoal } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/story-goals-store.js';
import { createVariableValue } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/variables-store.js';

const TL = 'tl-macros';
const SC = 'sc-macros';

beforeEach(() => __setExtensionSettings({ remodel: {} }));

test('{{loom.action}} wraps the player action as authoritative, and is empty when blank', () => {
    const rendered = renderLoomAction('Aiden shoulders the iron door.');
    expect(rendered).toContain('AUTHORITATIVE TURN INPUT');
    expect(rendered).toContain('Aiden shoulders the iron door.');
    expect(renderLoomAction('   ')).toBe('');
});

test('{{loom.goals}} shows open goals with their Success Rate number', () => {
    expect(renderLoomGoals(TL)).toBe('');
    createTimelineGoal(TL, {
        title: 'Escape the compound',
        description: 'the gate is unguarded before dawn',
        successRate: 55,
        holderRefs: [{ kind: 'character', id: 'Aiden', label: 'Aiden' }],
    }, { actor: 'loom' });
    const out = renderLoomGoals(TL);
    expect(out).toContain('## Goals');
    expect(out).toContain('- Escape the compound — 55%');
    expect(out).toContain('the gate is unguarded before dawn');
    expect(out).toContain('Held by: Aiden');
});

test('{{loom.goals}} hides secret Goals unless secret=true', () => {
    createTimelineGoal(TL, {
        title: 'Betray the crew at the dock', description: 'unbeknownst to the others', successRate: 40,
        visibility: 'secret', holderRefs: [{ kind: 'character', id: 'Rae', label: 'Rae' }],
    }, { actor: 'loom' });
    createTimelineGoal(TL, {
        title: 'Reach the harbour', description: 'before the tide turns', successRate: 60,
        holderRefs: [{ kind: 'character', id: 'Rae', label: 'Rae' }],
    }, { actor: 'loom' });
    // Default (player-facing) view: the secret Goal is absent.
    const hidden = renderLoomGoals(TL);
    expect(hidden).toContain('Reach the harbour');
    expect(hidden).not.toContain('Betray the crew');
    // Loom view: secret=true reveals it.
    const shown = renderLoomGoals(TL, { secret: true });
    expect(shown).toContain('Betray the crew');
    expect(shown).toContain('Reach the harbour');
});

test('{{loom.variables}} shows variable name, value, and meaning', () => {
    expect(renderLoomVariables(TL)).toBe('');
    createVariableValue({
        timelineId: TL, name: "Aiden's Nerve", description: 'his steadiness under pressure',
        valueType: 'number', value: 12,
        loreLinks: [{ book: 'Compound', uid: 4 }], retrieval: { mode: 'corroborated' }, authority: 'world',
    }, { actor: 'user' });
    const out = renderLoomVariables(TL);
    expect(out).toContain('## Variables');
    expect(out).toContain("- Aiden's Nerve: 12 — his steadiness under pressure");
});

test('routeUniversalStateMacros re-routes the surviving self-contained macros (post-activation fix)', async () => {
    // Regression for the review finding: after Narrator profile activation
    // clears the native prompt objects, the self-contained macros must be
    // re-routed, or {{loom.goals}}/{{loom.variables}} render blank.
    const { routeUniversalStateMacros } = await import('../public/scripts/extensions/third-party/SillyTavern-Remodel/live-direction.js');
    createTimelineGoal(TL, { title: 'Signal the boat', description: 'at dusk', successRate: 50 }, { actor: 'loom' });
    const routed = {};
    routeUniversalStateMacros((key, content) => { routed[key] = typeof content === 'function' ? content({}) : content; return true; }, { timelineId: TL, id: SC });
    expect(Object.keys(routed).sort()).toEqual(['loomGoals', 'loomVariables']);
    expect(routed.loomGoals).toContain('Signal the boat');
});
