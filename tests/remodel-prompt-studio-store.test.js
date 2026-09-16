import {
    initializePromptStudioStore,
    createPromptRecipe,
    createPromptBlockFromTemplate,
    getPromptRecipe,
    getStoryArchiveLoomRecipe,
    NARRATOR_POLICY_DEFAULT,
    normalizeRecipe,
    PROMPT_MODES,
    updatePromptRecipe,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/prompt-studio-store.js';
import { __getExtensionSettings, __setExtensionSettings } from './util/st-context-stub.js';
import {
    STORY_ARCHIVE_CONTRACT,
    STORY_ARCHIVE_CONTRACT_TYPED_PROPOSALS,
    STORY_ARCHIVE_POLICY,
    STORY_ARCHIVE_POLICY_TYPED_PROPOSALS,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/story-loom-contract.js';

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

test('Story Archive exposes a distinct accepted-capture macro and migrates its seeded recipe to it', () => {
    __setExtensionSettings({ remodel: { promptStudioV1: {
        version: 31,
        recipeIds: ['story-archive'],
        recipes: {
            'story-archive': {
                id: 'story-archive', name: 'Loom · Story Archive', mode: 'loom', apiType: 'chat',
                blocks: [{ id: 'capture', kind: 'source', sourceKey: 'narratorDraft', role: 'user', content: '{{narrator.draft}}', enabled: true }],
            },
        },
        active: { loom: { chat: 'story-archive' } },
    } } });

    const store = initializePromptStudioStore();
    const capture = store.recipes['story-archive'].blocks[0];
    expect(createPromptBlockFromTemplate('loom', 'storyArchiveCapture')).toMatchObject({ content: '{{story.archive_capture}}' });
    expect(capture).toMatchObject({ content: '{{story.archive_capture}}' });
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
    expect(store.version).toBe(31);
    expect(recipe.blocks.some((block) => block.content === '{{loom.context}}')).toBe(false);
    expect(recipe.blocks).toEqual(expect.arrayContaining([
        expect.objectContaining({ content: NARRATOR_POLICY_DEFAULT, locked: false }),
        expect.objectContaining({ content: '{{narrator.recall scenes=3}}', nativeIdentifier: 'remodel_narrator_recall' }),
    ]));
    expect(store.recipeIds.map((id) => store.recipes[id]?.name)).toContain('Narrator · Archive-Grounded');
    expect(settings.remodel.promptStudioV1.active.roleplay.chat).toBe('rp');
});

test('v29 replaces current-Scene Narrator grounding with earlier-Scene recall and retires the clock source', () => {
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
    expect(narrator).toEqual(expect.arrayContaining([
        expect.objectContaining({ content: '{{narrator.recall scenes=3}}', nativeIdentifier: 'remodel_narrator_recall' }),
    ]));
    expect(narrator.some((block) => /narrator\.time|remodel_narrator_time/i.test(`${block.content} ${block.nativeIdentifier}`))).toBe(false);
    expect(loom).toMatch(/loom\.lore|loreProposals|lorePromotionDecisions/);
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
    expect(store.version).toBe(31);
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

    expect(store.version).toBe(31);
    expect(blocks).toContain('{{loom.lore}}');
    expect(blocks).toContain('"loreProposals":[]');
    expect(blocks).toContain('"lorePromotionDecisions":[]');
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

    expect(store.version).toBe(31);
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
    expect(store.version).toBe(31);
    expect(store.recipes.legacy.blocks[0].content).toBe(legacyRewrite);
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
    expect(store.version).toBe(31);
    expect(contents).toContain(STORY_ARCHIVE_POLICY);
    expect(contents).toContain(STORY_ARCHIVE_CONTRACT);
    expect(contents).toContain('{{loom.lore}}');
    expect(contents).not.toContain(legacyPolicy);
});

test('v27 migrates the untouched Story Archive lore report contract to the intake shape', () => {
    __setExtensionSettings({ remodel: { promptStudioV1: {
        version: 26,
        recipeIds: ['story-archive'],
        recipes: {
            'story-archive': {
                id: 'story-archive', name: 'Loom · Story Archive', mode: 'loom', apiType: 'chat',
                blocks: [
                    { id: 'policy', kind: 'message', role: 'system', content: STORY_ARCHIVE_POLICY_TYPED_PROPOSALS, enabled: true },
                    { id: 'contract', kind: 'message', role: 'system', content: STORY_ARCHIVE_CONTRACT_TYPED_PROPOSALS, enabled: true },
                ],
            },
        },
        active: { loom: { chat: 'story-archive' } },
    } } });

    const store = initializePromptStudioStore();
    const contents = store.recipes['story-archive'].blocks.map((block) => block.content);
    expect(store.version).toBe(31);
    expect(contents).toContain(STORY_ARCHIVE_POLICY);
    expect(contents).toContain(STORY_ARCHIVE_CONTRACT);
    expect(contents).not.toContain(STORY_ARCHIVE_POLICY_TYPED_PROPOSALS);
    expect(contents).not.toContain(STORY_ARCHIVE_CONTRACT_TYPED_PROPOSALS);
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
    expect(store.version).toBe(31);
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
    expect(store.version).toBe(31);
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
    expect(store.version).toBe(31);
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

    expect(store.version).toBe(31);
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

    expect(store.version).toBe(31);
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
