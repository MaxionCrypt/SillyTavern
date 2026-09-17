import { __setExtensionSettings } from './util/st-context-stub.js';
import {
    renderLoomAction, renderLoomScene, renderLoomCharacters, renderLoomEvents,
    renderLoomSecrets, renderLoomGoals, renderLoomVariables, renderPrevEvents,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/narrator-prompt.js';
import { setSceneFact, setCharStateFacet, recordEvent, setSecret } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/archivist-store.js';
import { createTimelineGoal } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/story-goals-store.js';
import { createVariableValue } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/variables-store.js';
import { createArc, createScene, createTimeline } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/timeline-state.js';

const TL = 'tl-macros';
const SC = 'sc-macros';

beforeEach(() => __setExtensionSettings({ remodel: {} }));

test('{{loom.action}} wraps the player action as authoritative, and is empty when blank', () => {
    const rendered = renderLoomAction('Aiden shoulders the iron door.');
    expect(rendered).toContain('AUTHORITATIVE TURN INPUT');
    expect(rendered).toContain('Aiden shoulders the iron door.');
    expect(renderLoomAction('   ')).toBe('');
});

test('{{loom.scene}} lists scene facts under a Scene header, empty when none', () => {
    expect(renderLoomScene(TL, SC)).toBe('');
    setSceneFact(TL, SC, 'location', 'the east courtyard');
    const out = renderLoomScene(TL, SC);
    expect(out).toContain('## Scene');
    expect(out).toContain('- location: the east courtyard');
});

test('{{loom.characters}} lists character facets, empty when none', () => {
    expect(renderLoomCharacters(TL, SC)).toBe('');
    setCharStateFacet(TL, SC, 'Aiden', 'mood', 'rattled');
    const out = renderLoomCharacters(TL, SC);
    expect(out).toContain('## Characters');
    expect(out).toMatch(/- Aiden — mood: rattled/);
});

test('{{loom.events}} shows the current scene events, empty when none', () => {
    expect(renderLoomEvents(TL, SC)).toBe('');
    recordEvent(TL, SC, 'Aiden slipped past the first patrol.');
    const out = renderLoomEvents(TL, SC);
    expect(out).toContain('do NOT narrate this again');
    expect(out).toContain('Aiden slipped past the first patrol.');
});

test('{{loom.secrets}} is separate from scene facts and marked hidden, empty when none', () => {
    expect(renderLoomSecrets(TL, SC)).toBe('');
    setSecret(TL, SC, 'the buyer', 'Marissa, unbeknownst to Aiden');
    const out = renderLoomSecrets(TL, SC);
    expect(out).toContain('hidden from the player');
    expect(out).toContain('- the buyer: Marissa, unbeknownst to Aiden');
    // Secrets must NOT leak into the plain scene-fact surface.
    expect(renderLoomScene(TL, SC)).not.toContain('the buyer');
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

test('{{prev.events}} disables at scenes=0 and is empty with no earlier Scenes', () => {
    expect(renderPrevEvents(TL, SC, { scenes: 0 })).toBe('');
    expect(renderPrevEvents(TL, SC, { scenes: 3 })).toBe('');
});

test('{{prev.events}} reads every event of the earlier Scenes directly (last event not dropped)', () => {
    const tl = createTimeline('Prev').id;
    const arc = createArc(tl, 'Arc').id;
    const earlier = createScene(arc, 'roleplay', 'The Cellar').id;
    const current = createScene(arc, 'roleplay', 'The Loft').id;
    recordEvent(tl, earlier, 'The first thing happened.');
    recordEvent(tl, earlier, 'The middle thing happened.');
    recordEvent(tl, earlier, 'The last thing happened.');
    recordEvent(tl, current, 'This is the current Scene.');
    const out = renderPrevEvents(tl, current, { scenes: 3 });
    expect(out).toContain('## Earlier Scenes');
    expect(out).toContain('The first thing happened.');
    expect(out).toContain('The last thing happened.'); // completeness — no silent drop
    expect(out).not.toContain('This is the current Scene.'); // current Scene excluded
});

test('routeUniversalStateMacros re-routes all six self-contained macros (post-activation fix)', async () => {
    // Regression for the review finding: after Narrator profile activation
    // clears the native prompt objects, the self-contained macros must be
    // re-routed, or {{loom.scene}}/{{loom.goals}} render blank.
    const { routeUniversalStateMacros } = await import('../public/scripts/extensions/third-party/SillyTavern-Remodel/live-direction.js');
    setSceneFact(TL, SC, 'location', 'the pier');
    createTimelineGoal(TL, { title: 'Signal the boat', description: 'at dusk', successRate: 50 }, { actor: 'loom' });
    const routed = {};
    routeUniversalStateMacros((key, content) => { routed[key] = typeof content === 'function' ? content({}) : content; return true; }, { timelineId: TL, id: SC });
    expect(Object.keys(routed).sort()).toEqual(['loomCharacters', 'loomEvents', 'loomGoals', 'loomScene', 'loomSecrets', 'loomVariables']);
    expect(routed.loomScene).toContain('- location: the pier');
    expect(routed.loomGoals).toContain('Signal the boat');
});
