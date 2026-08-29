import {
    initializePromptStudioStore,
    getStoryArchiveLoomRecipe,
    NARRATOR_POLICY_DEFAULT,
    normalizeRecipe,
    PROMPT_MODES,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/prompt-studio-store.js';
import { __setExtensionSettings } from './util/st-context-stub.js';
import { STORY_ARCHIVE_CONTRACT, STORY_ARCHIVE_POLICY } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/story-loom-contract.js';

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
    expect(store.version).toBe(26);
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

    expect(store.version).toBe(26);
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


test('v18 policy treats every Goal as a consequential outcome', async () => {
    const { LOOM_POLICY_PATCH } = await import('../public/scripts/extensions/third-party/SillyTavern-Remodel/loom-reconciliation.js');
    expect(LOOM_POLICY_PATCH).toMatch(/goal\.create/);
    expect(LOOM_POLICY_PATCH).toMatch(/what materially changed/i);
    expect(LOOM_POLICY_PATCH).toMatch(/helps or obstructs/i);
    expect(LOOM_POLICY_PATCH).toMatch(/success rate/i);
    expect(LOOM_POLICY_PATCH).toMatch(/even when no roll/i);
    expect(LOOM_POLICY_PATCH).not.toMatch(/standing want/i);
    expect(LOOM_POLICY_PATCH).toMatch(/impossible/);
    expect(LOOM_POLICY_PATCH).toMatch(/abandoned/);
    expect(LOOM_POLICY_PATCH).toMatch(/goal\.edit/);
});

test('v18 migrates the untouched full policy and never an edited one', async () => {
    const { LOOM_POLICY_DEFAULT, LOOM_POLICY_DEFAULT_PRIOR } = await import('../public/scripts/extensions/third-party/SillyTavern-Remodel/loom-reconciliation.js');
    const recipes = {
        edited: { id: 'edited', name: 'Mine', mode: 'loom', apiType: 'chat', blocks: [{ id: 'b', kind: 'message', role: 'system', content: 'my own policy' }] },
        full: { id: 'full', name: 'Full', mode: 'loom', apiType: 'chat', blocks: [{ id: 'full-policy', kind: 'message', role: 'system', content: LOOM_POLICY_DEFAULT_PRIOR }] },
    };
    const ids = ['edited', 'full'];
    __setExtensionSettings({ remodel: { promptStudioV1: { version: 17, recipeIds: ids, recipes, active: { loom: { chat: 'full' } } } } });

    const store = initializePromptStudioStore();
    expect(store.version).toBe(26);
    expect(store.recipes.full.blocks[0].content).toBe(LOOM_POLICY_DEFAULT);
    expect(store.recipes.edited.blocks[0].content).toBe('my own policy');
});

test('Prompt Studio seeds one editable Story Archive Loom recipe without replacing the Roleplay default', () => {
    __setExtensionSettings({ remodel: {} });
    const store = initializePromptStudioStore();
    const recipe = getStoryArchiveLoomRecipe();
    expect(recipe?.name).toBe('Loom · Story Archive');
    expect(recipe?.blocks.map((block) => block.content).join('\n')).toContain('manuscript is immutable');
    expect(store.active.loom.chat).not.toBe(recipe.id);
});

test('v21 repairs the contradictory untouched Story Archive recipe and exposes Living Lore', () => {
    const legacyPolicy = 'You are the Loom reading an accepted Story manuscript passage after it has already been written. Goals, Variables, rolls, lore proposals, flow control, and swaps are disabled for this stage.';
    const legacyContract = 'Output NOTHING except one state fence:\n```state\n{"requests":[],"loreProposals":[],"flow":{"continue":false}}\n```';
    __setExtensionSettings({ remodel: { promptStudioV1: {
        version: 20,
        recipeIds: ['story-archive'],
        recipes: {
            'story-archive': {
                id: 'story-archive', name: 'Loom · Story Archive', mode: 'loom', apiType: 'chat',
                blocks: [
                    { id: 'policy', kind: 'message', role: 'system', content: legacyPolicy, enabled: true },
                    { id: 'draft', kind: 'message', role: 'user', content: '{{narrator.draft}}', enabled: true },
                    { id: 'contract', kind: 'message', role: 'system', content: legacyContract, enabled: true },
                ],
            },
        },
        active: { loom: { chat: 'story-archive' } },
    } } });

    const store = initializePromptStudioStore();
    const contents = store.recipes['story-archive'].blocks.map((block) => block.content);
    expect(store.version).toBe(26);
    expect(contents).toContain(STORY_ARCHIVE_POLICY);
    expect(contents).toContain(STORY_ARCHIVE_CONTRACT);
    expect(contents).toContain('{{loom.lore}}');
    expect(contents).not.toContain(legacyPolicy);
});

test('v22 gives the untouched Patch Loom a durable lore check and preserves authored text', async () => {
    const { LOOM_OUTPUT_CONTRACT_PATCH, LOOM_OUTPUT_CONTRACT_PATCH_PRE_LORE, LOOM_POLICY_PATCH } = await import('../public/scripts/extensions/third-party/SillyTavern-Remodel/loom-reconciliation.js');
    const priorPolicy = LOOM_POLICY_PATCH.replace(/\nSTEP 4 - Durable Lore Check\.[\s\S]*$/, '');
    const priorContract = LOOM_OUTPUT_CONTRACT_PATCH_PRE_LORE;
    __setExtensionSettings({ remodel: { promptStudioV1: {
        version: 21,
        recipeIds: ['patch', 'mine'],
        recipes: {
            patch: {
                id: 'patch', name: 'Loom Â· Patch (fast)', mode: 'loom', apiType: 'chat',
                blocks: [
                    { id: 'policy', kind: 'message', role: 'system', content: priorPolicy, enabled: true },
                    { id: 'contract', kind: 'message', role: 'system', content: priorContract, enabled: true },
                ],
            },
            mine: {
                id: 'mine', name: 'My Loom', mode: 'loom', apiType: 'chat',
                blocks: [
                    { id: 'policy', kind: 'message', role: 'system', content: 'my durable lore policy', enabled: true },
                    { id: 'contract', kind: 'message', role: 'system', content: 'my private output contract', enabled: true },
                ],
            },
        },
        active: { loom: { chat: 'patch' } },
    } } });

    const store = initializePromptStudioStore();
    const patchContents = store.recipes.patch.blocks.map((block) => block.content);
    const authoredContents = store.recipes.mine.blocks.map((block) => block.content);
    expect(store.version).toBe(26);
    expect(patchContents).toContain(LOOM_POLICY_PATCH);
    expect(patchContents).toContain(LOOM_OUTPUT_CONTRACT_PATCH);
    expect(LOOM_POLICY_PATCH).toMatch(/STEP 4 - Durable Lore Check/);
    expect(LOOM_POLICY_PATCH).toMatch(/Most turns may correctly return no proposals/);
    expect(LOOM_OUTPUT_CONTRACT_PATCH).toContain('"loreProposals":[]');
    expect(authoredContents).toContain('my durable lore policy');
    expect(authoredContents).toContain('my private output contract');
});

test('v19 adds the editable selected-lore macro without changing authored Loom text', () => {
    __setExtensionSettings({ remodel: { promptStudioV1: {
        version: 18,
        recipeIds: ['mine'],
        recipes: { mine: { id: 'mine', name: 'Mine', mode: 'loom', apiType: 'chat', blocks: [
            { id: 'policy', kind: 'message', role: 'system', content: 'my authored policy', enabled: true },
            { id: 'draft', kind: 'message', role: 'user', content: '{{narrator.draft}}', enabled: true },
        ] } },
        active: { loom: { chat: 'mine' } },
    } } });

    const store = initializePromptStudioStore();
    const contents = store.recipes.mine.blocks.map((block) => block.content);
    expect(store.version).toBe(26);
    expect(contents).toContain('my authored policy');
    expect(contents).toContain('{{loom.lore}}');
    expect(contents.indexOf('{{loom.lore}}')).toBeLessThan(contents.indexOf('{{narrator.draft}}'));
});

test('v23 adds the current player action macro without changing authored Loom policy', () => {
    __setExtensionSettings({ remodel: { promptStudioV1: {
        version: 22,
        recipeIds: ['mine'],
        recipes: { mine: { id: 'mine', name: 'Mine', mode: 'loom', apiType: 'chat', blocks: [
            { id: 'policy', kind: 'message', role: 'system', content: 'my authored policy', enabled: true },
            { id: 'draft', kind: 'message', role: 'user', content: '{{narrator.draft}}', enabled: true },
        ] } },
        active: { loom: { chat: 'mine' } },
    } } });

    const store = initializePromptStudioStore();
    const contents = store.recipes.mine.blocks.map((block) => block.content);
    expect(store.version).toBe(26);
    expect(contents).toContain('my authored policy');
    expect(contents).toContain('{{player.action}}');
    expect(contents.indexOf('{{player.action}}')).toBeLessThan(contents.indexOf('{{narrator.draft}}'));
});

test('v24 rescues a Patch Loom stranded on the pre-promotion contract', async () => {
    const { LOOM_OUTPUT_CONTRACT_PATCH, LOOM_OUTPUT_CONTRACT_PATCH_PRE_PROMOTION, LOOM_POLICY_PATCH } = await import('../public/scripts/extensions/third-party/SillyTavern-Remodel/loom-reconciliation.js');
    __setExtensionSettings({ remodel: { promptStudioV1: {
        version: 23,
        recipeIds: ['patch', 'mine'],
        recipes: {
            patch: {
                id: 'patch', name: 'Loom (fast)', mode: 'loom', apiType: 'chat',
                blocks: [
                    { id: 'policy', kind: 'message', role: 'system', content: LOOM_POLICY_PATCH, enabled: true },
                    { id: 'contract', kind: 'message', role: 'system', content: LOOM_OUTPUT_CONTRACT_PATCH_PRE_PROMOTION, enabled: true },
                ],
            },
            mine: {
                id: 'mine', name: 'My Loom', mode: 'loom', apiType: 'chat',
                blocks: [
                    { id: 'contract', kind: 'message', role: 'system', content: 'my private output contract', enabled: true },
                ],
            },
        },
        active: { loom: { chat: 'patch' } },
    } } });

    const store = initializePromptStudioStore();
    const patchContents = store.recipes.patch.blocks.map((block) => block.content);

    expect(store.version).toBe(26);
    expect(patchContents).toContain(LOOM_OUTPUT_CONTRACT_PATCH);
    expect(patchContents).not.toContain(LOOM_OUTPUT_CONTRACT_PATCH_PRE_PROMOTION);
    expect(store.recipes.mine.blocks.map((block) => block.content)).toContain('my private output contract');
});

test('the pre-promotion contract is exactly the one that omits the promotion receipt', async () => {
    const { LOOM_OUTPUT_CONTRACT_PATCH, LOOM_OUTPUT_CONTRACT_PATCH_PRE_PROMOTION } = await import('../public/scripts/extensions/third-party/SillyTavern-Remodel/loom-reconciliation.js');
    expect(LOOM_OUTPUT_CONTRACT_PATCH).toContain('"lorePromotionDecisions":[]');
    expect(LOOM_OUTPUT_CONTRACT_PATCH).toContain('When promotion candidates are present');
    expect(LOOM_OUTPUT_CONTRACT_PATCH_PRE_PROMOTION).not.toContain('lorePromotionDecisions');
    expect(LOOM_OUTPUT_CONTRACT_PATCH_PRE_PROMOTION).not.toContain('When promotion candidates are present');
    expect(LOOM_OUTPUT_CONTRACT_PATCH_PRE_PROMOTION).toContain('Always include the top-level loreProposals array');
});

test('v26 gives a Roleplay recipe the Continue and Mechanics blocks after Chat History', () => {
    __setExtensionSettings({ remodel: { promptStudioV1: {
        version: 24,
        recipeIds: ['rp'],
        recipes: { rp: { id: 'rp', name: 'RP', mode: 'roleplay', apiType: 'chat', blocks: [
            { id: 'h', kind: 'message', role: 'user', content: '{{chat.history}}', enabled: true },
            { id: 'mine', kind: 'message', role: 'system', content: 'my authored note', enabled: true },
        ] } },
        active: { roleplay: { chat: 'rp' } },
    } } });

    const store = initializePromptStudioStore();
    const contents = store.recipes.rp.blocks.map((block) => block.content);

    expect(store.version).toBe(26);
    expect(contents.some((content) => content.includes('{{narrator.continue'))).toBe(true);
    expect(contents.some((content) => content.includes('{{narrator.mechanics'))).toBe(true);
    // Placed after the history they continue from, and authored text untouched.
    expect(contents.indexOf('{{chat.history}}')).toBeLessThan(contents.findIndex((c) => c.includes('{{narrator.continue')));
    expect(contents).toContain('my authored note');
});

test('v26 does not duplicate blocks a recipe already has', () => {
    __setExtensionSettings({ remodel: { promptStudioV1: {
        version: 24,
        recipeIds: ['rp'],
        recipes: { rp: { id: 'rp', name: 'RP', mode: 'roleplay', apiType: 'chat', blocks: [
            { id: 'c', kind: 'message', role: 'user', content: '{{narrator.continue text="mine"}}', enabled: true, nativeIdentifier: 'remodel_narrator_continue' },
            { id: 'm', kind: 'message', role: 'user', content: '{{narrator.mechanics tools="goal.attempt"}}', enabled: true, nativeIdentifier: 'remodel_narrator_mechanics' },
        ] } },
        active: { roleplay: { chat: 'rp' } },
    } } });

    const contents = initializePromptStudioStore().recipes.rp.blocks.map((block) => block.content);
    expect(contents.filter((content) => content.includes('{{narrator.continue'))).toHaveLength(1);
    expect(contents.filter((content) => content.includes('{{narrator.mechanics'))).toHaveLength(1);
    expect(contents).toContain('{{narrator.continue text="mine"}}');
});
