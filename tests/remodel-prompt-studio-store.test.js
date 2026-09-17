import {
    initializePromptStudioStore,
    createPromptRecipe,
    createPromptBlockFromTemplate,
    getPromptRecipe,
    NARRATOR_POLICY_DEFAULT,
    normalizeRecipe,
    PROMPT_MODES,
    updatePromptRecipe,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/prompt-studio-store.js';
import { __getExtensionSettings, __setExtensionSettings } from './util/st-context-stub.js';

test('Prompt Studio exposes Loom as its hidden-pass mode', () => {
    expect(PROMPT_MODES).toEqual(['story', 'roleplay', 'loom']);
});

test('Roleplay exposes Narrator Note as an opt-in recipe macro', () => {
    expect(createPromptBlockFromTemplate('roleplay', 'narratorNote')).toMatchObject({
        role: 'system',
        content: '{{narrator.note}}',
        nativeIdentifier: 'remodel_narrator_note',
    });
});

test('Roleplay exposes Next Action as a separately placeable user macro', () => {
    expect(createPromptBlockFromTemplate('roleplay', 'nextAction')).toMatchObject({
        role: 'user',
        content: '{{next.action}}',
        nativeIdentifier: 'remodel_next_action',
    });
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

test('legacy locked blocks normalize as fully user-owned recipe blocks', () => {
    const recipe = normalizeRecipe({
        id: 'unlocked-1',
        mode: 'roleplay',
        apiType: 'chat',
        blocks: [{ kind: 'message', role: 'system', content: 'A native marker', locked: true, nativeIdentifier: 'charDescription' }],
    });
    expect(recipe.blocks[0]).toMatchObject({
        locked: false,
        nativeIdentifier: 'charDescription',
    });
});

test('a current recipe does not re-add blocks the owner removed', () => {
    __setExtensionSettings({ remodel: { promptStudioV1: {
        version: 29,
        recipeIds: ['owner-recipe'],
        recipes: {
            'owner-recipe': {
                id: 'owner-recipe', name: 'Owner recipe', mode: 'roleplay', apiType: 'chat',
                blocks: [{ id: 'only', kind: 'message', role: 'system', content: 'Only this stays.', enabled: true }],
            },
        },
        active: { roleplay: { chat: 'owner-recipe' } },
    } } });

    const store = initializePromptStudioStore();
    expect(store.recipes['owner-recipe'].blocks.map((block) => block.content)).toEqual(['Only this stays.']);
});

test('the retired hidden Continue default is removed from an already-saved recipe', () => {
    __setExtensionSettings({ remodel: { promptStudioV1: {
        version: 29,
        recipeIds: ['old-continue'],
        recipes: {
            'old-continue': {
                id: 'old-continue', name: 'Old Continue', mode: 'roleplay', apiType: 'chat',
                blocks: [{
                    id: 'continue', kind: 'message', role: 'user', enabled: true,
                    nativeIdentifier: 'remodel_narrator_continue',
                    content: '{{narrator.continue text="Continue the scene autonomously from the accepted history. Return only the next new passage of scene prose. Do not repeat, summarize, or explain existing prose, and do not wait for player input."}}',
                }],
            },
        },
        active: { roleplay: { chat: 'old-continue' } },
    } } });

    const store = initializePromptStudioStore();
    expect(store.recipes['old-continue'].blocks).toHaveLength(0);
});

test('a Roleplay recipe preserves block reorder, addition, and deletion through settings rehydration', () => {
    __setExtensionSettings({});
    const recipe = createPromptRecipe({
        name: 'Persistence check',
        mode: 'roleplay',
        apiType: 'chat',
        blocks: [
            { id: 'first', kind: 'message', role: 'system', content: 'first' },
            { id: 'remove', kind: 'message', role: 'system', content: 'remove me' },
            { id: 'last', kind: 'message', role: 'system', content: 'last' },
        ],
    });

    updatePromptRecipe(recipe.id, { blocks: [
        { id: 'last', kind: 'message', role: 'system', content: 'last' },
        { id: 'added', kind: 'message', role: 'instruction', content: 'added' },
        { id: 'first', kind: 'message', role: 'system', content: 'first' },
    ] });

    const persistedSettings = structuredClone(__getExtensionSettings());
    __setExtensionSettings(persistedSettings);
    initializePromptStudioStore();

    expect(getPromptRecipe(recipe.id).blocks.map((block) => [block.id, block.content])).toEqual([
        ['last', 'last'],
        ['added', 'added'],
        ['first', 'first'],
    ]);
});

test('a legacy Narrator continuity source normalizes to empty now the Archive split macros are dissolved', () => {
    const recipe = normalizeRecipe({
        id: 'roleplay-1',
        mode: 'roleplay',
        apiType: 'chat',
        blocks: [{ kind: 'source', sourceKey: 'loomContext', role: 'system', nativeIdentifier: 'remodel_loom_context' }],
    });
    expect(recipe.blocks[0]).toMatchObject({
        kind: 'message',
        content: '',
        sourceKey: '',
        nativeIdentifier: '',
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
    expect(store.version).toBe(34);
    expect(recipe.blocks.some((block) => block.content === '{{loom.context}}')).toBe(false);
    expect(recipe.blocks).toEqual(expect.arrayContaining([
        expect.objectContaining({ content: NARRATOR_POLICY_DEFAULT, locked: false }),
    ]));
    expect(store.recipeIds.map((id) => store.recipes[id]?.name)).toContain('Narrator · Grounded');
    expect(settings.remodel.promptStudioV1.active.roleplay.chat).toBe('rp');
});

test('v29 removes current-Scene Narrator grounding and retires the clock source', () => {
    __setExtensionSettings({ remodel: { promptStudioV1: {
        version: 27,
        recipeIds: ['rp', 'loom-rp'],
        recipes: {
            rp: {
                id: 'rp', name: 'CROWN PROMPT ROLEPLAY', mode: 'roleplay', apiType: 'chat',
                blocks: [
                    { id: 'grounding', kind: 'message', role: 'system', content: '{{narrator.grounding}}', nativeIdentifier: 'remodel_narrator_grounding', enabled: true },
                    { id: 'history', kind: 'message', role: 'user', content: '{{chat.history}}', nativeIdentifier: 'chatHistory', enabled: true },
                ],
            },
            'loom-rp': {
                id: 'loom-rp', name: 'crown prompt loom - roleplay', mode: 'loom', apiType: 'chat',
                blocks: [
                    { id: 'sources', kind: 'message', role: 'system', content: '{{loom.archive}}\n\n{{loom.lore}}', enabled: true },
                    { id: 'contract', kind: 'message', role: 'system', content: '```state\n{"requests":[],"loreProposals":[],"loreKeywords":[],"lorePromotionDecisions":[],"flow":{"continue":false}}\n```\n\nEach `loreProposals` item is durable.\n\nUse `loreProposals`: [] when empty. When World Sense promotion candidates are present, return `lorePromotionDecisions`: [].', enabled: true },
                ],
            },
        },
        active: { roleplay: { chat: 'rp' }, loom: { chat: 'loom-rp' } },
    } } });

    const store = initializePromptStudioStore();
    const narrator = store.recipes.rp.blocks;
    const loom = store.recipes['loom-rp'].blocks.map((block) => block.content).join('\n');

    expect(narrator.some((block) => /narrator\.grounding/.test(block.content))).toBe(false);
    expect(narrator.some((block) => /prev\.events|remodel_prev_events/.test(`${block.content} ${block.nativeIdentifier}`))).toBe(false);
    expect(narrator.some((block) => /narrator\.time|remodel_narrator_time/i.test(`${block.content} ${block.nativeIdentifier}`))).toBe(false);
    expect(loom).toMatch(/loom\.lore|loreProposals/);
    expect(loom).toMatch(/loreKeywords/);
});

test('v30 adds Next Action immediately after Chat History once', () => {
    __setExtensionSettings({ remodel: { promptStudioV1: {
        version: 29,
        recipeIds: ['rp'],
        recipes: { rp: {
            id: 'rp', name: 'RP', mode: 'roleplay', apiType: 'chat',
            blocks: [
                { id: 'history', kind: 'message', role: 'user', content: '{{chat.history}}', enabled: true },
                { id: 'tail', kind: 'message', role: 'system', content: 'Write next.', enabled: true },
            ],
        } },
        active: { roleplay: { chat: 'rp' } },
    } } });

    const store = initializePromptStudioStore();
    expect(store.version).toBe(34);
    expect(store.recipes.rp.blocks.map((block) => block.content)).toEqual([
        '{{chat.history}}', '{{next.action}}', 'Write next.',
    ]);

    const rehydrated = initializePromptStudioStore();
    expect(rehydrated.recipes.rp.blocks.filter((block) => block.content === '{{next.action}}')).toHaveLength(1);
});

test('v31 restores Living Lore routing and fence fields to Crown Roleplay Loom', () => {
    __setExtensionSettings({ remodel: { promptStudioV1: {
        version: 30,
        recipeIds: ['loom-rp'],
        recipes: { 'loom-rp': {
            id: 'loom-rp', name: 'Crown Prompt Loom - Roleplay', mode: 'loom', apiType: 'chat',
            blocks: [
                { id: 'policy', kind: 'message', role: 'system', content: 'Resolve the accepted turn.', enabled: true },
                { id: 'contract', kind: 'message', role: 'system', content: '```state\n{"requests":[],"loreKeywords":[],"flow":{"continue":false}}\n```', enabled: true },
            ],
        } },
        active: { loom: { chat: 'loom-rp' } },
    } } });

    const store = initializePromptStudioStore();
    const blocks = store.recipes['loom-rp'].blocks.map((block) => block.content).join('\n');

    expect(store.version).toBe(34);
    expect(blocks).toContain('{{loom.lore}}');
    expect(blocks).toContain('"loreProposals":[]');
    expect(blocks).toContain('## Living Lore — enabled');
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

    expect(store.version).toBe(34);
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

test('a retired rewrite recipe is left owner-authored, not force-converted or crashed', async () => {
    // The rewrite contract is gone, so an ancient recipe carrying it is no
    // longer recognised or upgraded — it stays exactly as authored and still
    // parses through parseLoomReply's prose branch.
    const legacyRewrite = 'You are the Loom: the final continuity editor, mechanical referee, and live voice of the scene. Return the complete final prose.';
    const recipes = {
        edited: { id: 'edited', name: 'Mine', mode: 'loom', apiType: 'chat', blocks: [{ id: 'b', kind: 'message', role: 'system', content: 'my own policy' }] },
        legacy: { id: 'legacy', name: 'Legacy', mode: 'loom', apiType: 'chat', blocks: [{ id: 'legacy-policy', kind: 'message', role: 'system', content: legacyRewrite }] },
    };
    __setExtensionSettings({ remodel: { promptStudioV1: { version: 17, recipeIds: ['edited', 'legacy'], recipes, active: { loom: { chat: 'legacy' } } } } });

    const store = initializePromptStudioStore();
    expect(store.version).toBe(34);
    expect(store.recipes.legacy.blocks[0].content).toBe(legacyRewrite);
    expect(store.recipes.edited.blocks[0].content).toBe('my own policy');
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
    expect(store.version).toBe(34);
    expect(patchContents).toContain(LOOM_POLICY_PATCH);
    expect(patchContents).toContain(LOOM_OUTPUT_CONTRACT_PATCH);
    expect(LOOM_POLICY_PATCH).toMatch(/STEP 3 - Durable Lore Check/);
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
    expect(store.version).toBe(34);
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
    expect(store.version).toBe(34);
    expect(contents).toContain('my authored policy');
    // v23 adds the player-action source; v32 renames it to loom.action.
    expect(contents).toContain('{{loom.action}}');
    expect(contents.indexOf('{{loom.action}}')).toBeLessThan(contents.indexOf('{{narrator.draft}}'));
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

    expect(store.version).toBe(34);
    expect(patchContents).toContain(LOOM_OUTPUT_CONTRACT_PATCH);
    expect(patchContents).not.toContain(LOOM_OUTPUT_CONTRACT_PATCH_PRE_PROMOTION);
    expect(store.recipes.mine.blocks.map((block) => block.content)).toContain('my private output contract');
});

test('the Loom output contract no longer carries the dissolved World Sense promotion receipt', async () => {
    const { LOOM_OUTPUT_CONTRACT_PATCH, LOOM_OUTPUT_CONTRACT_PATCH_PRE_PROMOTION } = await import('../public/scripts/extensions/third-party/SillyTavern-Remodel/loom-reconciliation.js');
    expect(LOOM_OUTPUT_CONTRACT_PATCH).not.toContain('lorePromotionDecisions');
    expect(LOOM_OUTPUT_CONTRACT_PATCH).not.toContain('When promotion candidates are present');
    expect(LOOM_OUTPUT_CONTRACT_PATCH_PRE_PROMOTION).not.toContain('lorePromotionDecisions');
    expect(LOOM_OUTPUT_CONTRACT_PATCH_PRE_PROMOTION).not.toContain('When promotion candidates are present');
    expect(LOOM_OUTPUT_CONTRACT_PATCH).toContain('Always include the top-level loreProposals array');
});

test('v26 retains the mechanics block without injecting a hidden Continue instruction', () => {
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

    expect(store.version).toBe(34);
    expect(contents.some((content) => content.includes('{{narrator.continue'))).toBe(false);
    expect(contents.some((content) => content.includes('{{narrator.mechanics'))).toBe(true);
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

test('v32 retires the bundled Loom boards into split state macros', () => {
    __setExtensionSettings({ remodel: { promptStudioV1: {
        version: 31,
        recipeIds: ['mine'],
        recipes: { mine: { id: 'mine', name: 'Mine', mode: 'loom', apiType: 'chat', blocks: [
            { id: 'policy', kind: 'message', role: 'system', content: 'authored policy', enabled: true },
            { id: 'action', kind: 'message', role: 'user', content: '{{player.action}}', enabled: true },
            { id: 'archive', kind: 'message', role: 'system', content: '{{loom.archive}}', enabled: true },
            { id: 'mech', kind: 'message', role: 'system', content: '{{loom.mechanics}}', enabled: true },
            { id: 'life', kind: 'message', role: 'system', content: '{{loom.lifecycle}}', enabled: true },
            { id: 'draft', kind: 'message', role: 'user', content: '{{narrator.draft}}', enabled: true },
        ] } },
        active: { loom: { chat: 'mine' } },
    } } });
    const contents = initializePromptStudioStore().recipes.mine.blocks.map((block) => block.content);
    const joined = contents.join('\n');
    // player.action renamed to loom.action
    expect(joined).toContain('{{loom.action}}');
    expect(joined).not.toContain('{{player.action}}');
    // loom.archive (and its split scene macros) are dropped entirely — the Loom Archive is dissolved
    expect(joined).not.toContain('{{loom.archive}}');
    expect(joined).not.toContain('{{loom.scene}}');
    expect(joined).not.toContain('{{loom.characters}}');
    expect(joined).not.toContain('{{loom.events}}');
    // loom.mechanics expanded into goals (with secrets, for the Loom) +
    // variables + the operations manual
    expect(contents).toContain('{{loom.goals secret=true}}');
    expect(contents).toContain('{{loom.variables}}');
    expect(joined).toContain('Operations — what you may change');
    expect(joined).not.toContain('{{loom.mechanics}}');
    // loom.lifecycle dropped entirely
    expect(joined).not.toContain('{{loom.lifecycle}}');
    // authored text and ordering preserved
    expect(joined).toContain('authored policy');
    expect(contents.indexOf('{{loom.action}}')).toBeLessThan(contents.indexOf('{{narrator.draft}}'));
});

test('v32 rewrites a dead board macro inside a mixed authored block without losing the rest', () => {
    __setExtensionSettings({ remodel: { promptStudioV1: {
        version: 31,
        recipeIds: ['mine'],
        recipes: { mine: { id: 'mine', name: 'Mine', mode: 'loom', apiType: 'chat', blocks: [
            { id: 'mixed', kind: 'message', role: 'system', content: '{{loom.archive}}\n\n{{loom.lore}}', enabled: true },
        ] } },
        active: { loom: { chat: 'mine' } },
    } } });
    const joined = initializePromptStudioStore().recipes.mine.blocks.map((block) => block.content).join('\n');
    expect(joined).not.toContain('{{loom.scene}}');   // the dead board macro is dropped, not rewritten
    expect(joined).toContain('{{loom.lore}}');   // the sibling macro in the same block survives
    expect(joined).not.toContain('{{loom.archive}}');
});

test('v33 retires the Narrator-specific state macros for the universal split ones', () => {
    __setExtensionSettings({ remodel: { promptStudioV1: {
        version: 32,
        recipeIds: ['rp'],
        recipes: { rp: { id: 'rp', name: 'RP', mode: 'roleplay', apiType: 'chat', blocks: [
            { id: 'grounding', kind: 'message', role: 'system', content: '{{narrator.grounding}}', nativeIdentifier: 'remodel_narrator_grounding', enabled: true },
            { id: 'goals', kind: 'message', role: 'system', content: '{{story.goals}}', nativeIdentifier: 'remodel_story_goals', enabled: true },
            { id: 'recall', kind: 'message', role: 'system', content: '{{narrator.recall scenes=5}}', nativeIdentifier: 'remodel_narrator_recall', enabled: true },
            { id: 'history', kind: 'message', role: 'user', content: '{{chat.history}}', enabled: true },
        ] } },
        active: { roleplay: { chat: 'rp' } },
    } } });
    const contents = initializePromptStudioStore().recipes.rp.blocks.map((block) => block.content);
    const joined = contents.join('\n');
    // grounding (and the split scene macros) are dropped entirely — the Loom Archive is dissolved
    expect(joined).not.toContain('{{loom.scene}}');
    expect(joined).not.toContain('{{loom.characters}}');
    expect(joined).not.toContain('{{loom.events}}');
    expect(joined).not.toContain('{{narrator.grounding}}');
    // story.goals → a "pressures" framing block + loom.goals (secrets hidden for the Narrator)
    expect(joined).toContain('pressures on the scene, never protected outcomes');
    expect(contents).toContain('{{loom.goals}}');
    expect(joined).not.toContain('{{story.goals}}');
    expect(joined).not.toContain('{{loom.goals secret=true}}');
    // narrator.recall (earlier-Scene Archive recall) is dropped entirely
    expect(joined).not.toContain('{{prev.events');
    expect(joined).not.toContain('{{narrator.recall');
});

test('a retired narratorGrounding source block normalizes to empty now the Archive split macros are dissolved', () => {
    const recipe = normalizeRecipe({
        id: 'rp-grounding', mode: 'roleplay', apiType: 'chat',
        blocks: [{ kind: 'source', sourceKey: 'narratorGrounding', role: 'system', nativeIdentifier: 'remodel_narrator_grounding' }],
    });
    expect(recipe.blocks[0]).toMatchObject({
        kind: 'message',
        content: '',
    });
});
