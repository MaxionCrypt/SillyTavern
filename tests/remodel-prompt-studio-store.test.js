import {
    initializePromptStudioStore,
    NARRATOR_POLICY_DEFAULT,
    normalizeRecipe,
    PROMPT_MODES,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/prompt-studio-store.js';
import { __setExtensionSettings } from './util/st-context-stub.js';

test('Prompt Studio exposes Loom as its hidden-pass mode', () => {
    expect(PROMPT_MODES).toEqual(['story', 'roleplay', 'loom']);
});

test('Loom recipes are normalized to Chat Completion', () => {
    const recipe = normalizeRecipe({ id: 'loom-1', mode: 'loom', apiType: 'text', blocks: [] });
    expect(recipe.apiType).toBe('chat');
});

test('advanced output-contract warnings survive recipe normalization', () => {
    const recipe = normalizeRecipe({
        id: 'loom-2',
        mode: 'loom',
        apiType: 'chat',
        blocks: [{ kind: 'message', role: 'system', content: '```state\n{}\n```', advancedWarning: 'Schema warning' }],
    });
    expect(recipe.blocks[0].advancedWarning).toBe('Schema warning');
});

test('legacy Narrator continuity sources normalize to the canonical grounding macro', () => {
    const recipe = normalizeRecipe({
        id: 'roleplay-1',
        mode: 'roleplay',
        apiType: 'chat',
        blocks: [{ kind: 'source', sourceKey: 'loomContext', role: 'system', nativeIdentifier: 'remodel_loom_context' }],
    });
    expect(recipe.blocks[0]).toMatchObject({
        kind: 'message',
        content: '{{narrator.grounding}}',
        sourceKey: '',
        nativeIdentifier: 'remodel_narrator_grounding',
    });
});

test('v13 stores migrate old hidden grounding into an editable recipe policy and macro', () => {
    const settings = __setExtensionSettings({
        remodel: {
            promptStudioV1: {
                version: 13,
                recipeIds: ['rp'],
                recipes: {
                    rp: {
                        id: 'rp',
                        name: 'My Narrator',
                        mode: 'roleplay',
                        apiType: 'chat',
                        blocks: [{
                            id: 'old-grounding',
                            kind: 'message',
                            role: 'system',
                            content: '{{loom.context}}',
                            nativeIdentifier: 'remodel_loom_context',
                        }],
                    },
                },
                active: { roleplay: { chat: 'rp' } },
            },
        },
    });

    const store = initializePromptStudioStore();
    const recipe = store.recipes.rp;
    expect(store.version).toBe(17);
    expect(recipe.blocks.some((block) => block.content === '{{loom.context}}')).toBe(false);
    expect(recipe.blocks).toEqual(expect.arrayContaining([
        expect.objectContaining({ content: NARRATOR_POLICY_DEFAULT, locked: false }),
        expect.objectContaining({ content: '{{narrator.grounding}}', nativeIdentifier: 'remodel_narrator_grounding' }),
    ]));
    expect(store.recipeIds.map((id) => store.recipes[id]?.name)).toContain('Narrator · Archive-Grounded');
    expect(settings.remodel.promptStudioV1.active.roleplay.chat).toBe('rp');
});


// v15: the Loom stops re-typing the turn it was handed. Measured on a live
// session, the full-prose contract cost 17-94s per turn reproducing prose that
// already existed. The user's own Loom recipe must survive — it may carry their
// edits — so the migration seeds a new one and switches to it rather than
// rewriting theirs.
test('v15 seeds the patch Loom recipe, activates it, and leaves the existing one intact', () => {
    __setExtensionSettings({
        remodel: {
            promptStudioV1: {
                version: 14,
                recipeIds: ['mine'],
                recipes: {
                    mine: {
                        id: 'mine', name: 'My Loom', mode: 'loom', apiType: 'chat',
                        blocks: [{ id: 'b1', kind: 'message', role: 'system', content: 'my own carefully edited policy' }],
                    },
                },
                active: { loom: { chat: 'mine' } },
            },
        },
    });
    const store = initializePromptStudioStore();

    expect(store.version).toBe(17);
    // The user's recipe is untouched and still selectable.
    expect(store.recipes.mine).toBeTruthy();
    expect(store.recipes.mine.blocks[0].content).toBe('my own carefully edited policy');

    // ...and a patch recipe now exists and is the active one.
    const patchId = store.recipeIds.find((id) => store.recipes[id]?.name === 'Loom · Patch (fast)');
    expect(patchId).toBeTruthy();
    expect(store.active.loom.chat).toBe(patchId);
    expect(store.active.loom.chat).not.toBe('mine');

    // The seeded recipe really carries the patch contract, not the old one.
    const blocks = store.recipes[patchId].blocks.map((b) => b.content).join(String.fromCharCode(10));
    expect(blocks).toMatch(/Output NOTHING except one state fence/);
    expect(blocks).not.toMatch(/complete final scene prose/);
});

test('v15 does not seed a second patch recipe on a store that already has one', () => {
    __setExtensionSettings({});
    const first = initializePromptStudioStore();
    const count = () => first.recipeIds.filter((id) => first.recipes[id]?.name === 'Loom · Patch (fast)').length;
    const again = initializePromptStudioStore();
    expect(again.recipeIds.filter((id) => again.recipes[id]?.name === 'Loom · Patch (fast)').length).toBeLessThanOrEqual(1);
    expect(count()).toBeLessThanOrEqual(1);
});


// v17: a Goal now covers a standing WANT as well as a contest. The Loom was
// offered goal.create from the start and never used it, because the mechanics
// board defined a Goal as a gamble and told it to "create one only when the
// fiction has raised the stakes itself". goalCount was 0 on all 35 turns of a
// live session and the Narrator's ## Objectives section never once appeared.
//
// Widening the definition removes the brake that kept creation rare, so the
// policy has to close what the fiction overtakes — otherwise every character
// accumulates wants nothing can resolve and ## Objectives becomes the wall
// this was meant to prevent.
test('v17 policy creates standing wants and closes the dead ones', async () => {
    const { LOOM_POLICY_PATCH, LOOM_POLICY_PATCH_PRIOR } = await import('../public/scripts/extensions/third-party/SillyTavern-Remodel/loom-reconciliation.js');
    expect(LOOM_POLICY_PATCH).toMatch(/standing want/i);
    expect(LOOM_POLICY_PATCH).toMatch(/goal\.create/);
    expect(LOOM_POLICY_PATCH).toMatch(/impossible/);
    expect(LOOM_POLICY_PATCH).toMatch(/abandoned/);
    expect(LOOM_POLICY_PATCH).toMatch(/goal\.edit/);
    // The brake is the WARNING, not the capability names: without a stated cost
    // the model has no reason to spend a request closing anything.
    expect(LOOM_POLICY_PATCH).toMatch(/noise you will be shown every turn/i);
    expect(LOOM_POLICY_PATCH_PRIOR.length).toBeGreaterThanOrEqual(2);
    expect(LOOM_POLICY_PATCH_PRIOR).not.toContain(LOOM_POLICY_PATCH);
});

test('v17 migrates every superseded policy and never an edited one', async () => {
    const { LOOM_POLICY_PATCH, LOOM_POLICY_PATCH_PRIOR } = await import('../public/scripts/extensions/third-party/SillyTavern-Remodel/loom-reconciliation.js');
    const recipes = { edited: { id: 'edited', name: 'Mine', mode: 'loom', apiType: 'chat', blocks: [{ id: 'b', kind: 'message', role: 'system', content: 'my own policy' }] } };
    const ids = ['edited'];
    LOOM_POLICY_PATCH_PRIOR.forEach((prior, i) => {
        const id = `prior${i}`;
        ids.push(id);
        recipes[id] = { id, name: `Loom v${i}`, mode: 'loom', apiType: 'chat', blocks: [{ id: `pb${i}`, kind: 'message', role: 'system', content: prior }] };
    });
    __setExtensionSettings({ remodel: { promptStudioV1: { version: 15, recipeIds: ids, recipes, active: { loom: { chat: 'prior0' } } } } });

    const store = initializePromptStudioStore();
    expect(store.version).toBe(17);
    for (let i = 0; i < LOOM_POLICY_PATCH_PRIOR.length; i += 1) {
        expect(store.recipes[`prior${i}`].blocks[0].content).toBe(LOOM_POLICY_PATCH);
    }
    expect(store.recipes.edited.blocks[0].content).toBe('my own policy');
});
