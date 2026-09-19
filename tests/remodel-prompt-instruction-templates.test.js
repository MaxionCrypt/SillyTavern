import {
    filterTemplates,
    getPromptInstructionTemplate,
    getPromptInstructionTemplates,
    templatePreview,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/prompt-instruction-templates.js';
import { buildMetadataGuide } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/metadata-guide.js';
import { PROMPT_ROLES, PROMPT_TEMPLATE_DEFINITIONS } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/prompt-studio-store.js';

const loom = () => getPromptInstructionTemplates('loom', 'chat');

describe('Prompt Studio instruction templates', () => {
    // After the Goals/Variables dissolution the picker carries exactly the two
    // things you cannot look up: the output contract and the Living Lore shapes.
    // There is no per-operation or Narrator-verb template anymore.

    // --- The whole point: no template is just a posted macro ---------------

    test('no template is a bare macro', () => {
        for (const mode of ['loom', 'roleplay', 'story']) {
            for (const apiType of ['chat', 'text']) {
                for (const template of getPromptInstructionTemplates(mode, apiType)) {
                    expect(template.content.trim()).not.toMatch(/^\{\{[^}]+\}\}$/);
                }
            }
        }
    });

    test('no template duplicates a macro source the reference already lists', () => {
        const macroKeys = new Set(Object.values(PROMPT_TEMPLATE_DEFINITIONS).flat().map((item) => item.key));
        for (const mode of ['loom', 'roleplay', 'story']) {
            for (const template of getPromptInstructionTemplates(mode, 'chat')) {
                expect(macroKeys.has(template.key)).toBe(false);
            }
        }
    });

    // --- Coverage: contract and lore, nothing else -------------------------

    test('the picker carries exactly the contract and lore templates', () => {
        expect(loom().map((template) => template.key)).toEqual([
            'contract.stateFence', 'contract.flow', 'lore.ops', 'lore.keywords',
        ]);
    });

    test('no dissolved operation or Narrator template survives', () => {
        for (const template of loom()) {
            expect(template.key.startsWith('operation.')).toBe(false);
            expect(template.key.startsWith('narrator.')).toBe(false);
            expect(template.group).not.toBe('narrator');
        }
    });

    test('the picker is ordered the way the Loom works, contract before lore', () => {
        const seen = [];
        for (const template of loom()) {
            if (seen.at(-1) !== template.groupLabel) seen.push(template.groupLabel);
        }
        // Each group appears exactly once — a group split across the list means
        // the ordering is the dictionary's, not the intended one.
        expect(seen).toEqual([...new Set(seen)]);
        expect(seen).toEqual(['Output contract', 'Living Lore']);
    });

    // --- The contract and the lore templates -------------------------------

    test('the state fence template carries a fence the parser accepts', () => {
        const template = getPromptInstructionTemplate('loom', 'chat', 'contract.stateFence');
        const match = template.content.match(/```state\s*\n([\s\S]*?)\n?```/i);
        expect(match).not.toBeNull();
        expect(() => JSON.parse(match[1])).not.toThrow();
    });

    test('the state fence template names every top-level key', () => {
        const template = getPromptInstructionTemplate('loom', 'chat', 'contract.stateFence');
        for (const item of buildMetadataGuide().envelope) {
            expect(template.content).toContain(`"${item.name}"`);
        }
    });

    test('the lore templates carry the shapes ops and retrieval accept', () => {
        const guide = buildMetadataGuide();
        expect(getPromptInstructionTemplate('loom', 'chat', 'lore.ops').content).toContain(guide.lore.ops.example);
        expect(getPromptInstructionTemplate('loom', 'chat', 'lore.keywords').content).toContain(guide.lore.keywords.example);
    });

    // --- Per-mode availability ---------------------------------------------

    // The picker is not a permission system: recipes belong to the owner, and a
    // template a mode hides cannot be talked into appearing.
    test('every mode and api type is offered the same templates', () => {
        const reference = loom().map((template) => template.key);
        expect(reference).toHaveLength(4);
        for (const mode of ['loom', 'roleplay', 'story']) {
            for (const apiType of ['chat', 'text']) {
                expect({ mode, apiType, keys: getPromptInstructionTemplates(mode, apiType).map((item) => item.key) })
                    .toEqual({ mode, apiType, keys: reference });
            }
        }
    });

    // --- Shape --------------------------------------------------------------

    test('every template is insertable as a message block', () => {
        for (const template of loom()) {
            expect(PROMPT_ROLES).toContain(template.role);
            expect(String(template.label || '').trim()).not.toBe('');
            expect(String(template.groupLabel || '').trim()).not.toBe('');
            expect(template.content.trim().length).toBeGreaterThan(40);
        }
    });

    test('keys are unique within a mode', () => {
        const keys = loom().map((template) => template.key);
        expect(keys).toEqual([...new Set(keys)]);
    });

    test('lookup finds a key in any mode, and returns null for one that does not exist', () => {
        expect(getPromptInstructionTemplate('loom', 'chat', 'contract.stateFence')).not.toBeNull();
        expect(getPromptInstructionTemplate('story', 'text', 'lore.ops')).not.toBeNull();
        expect(getPromptInstructionTemplate('loom', 'chat', 'nope')).toBeNull();
    });

    // The card menu shows these; a card with no summary is a bare name again.
    test('every template carries a summary for its card', () => {
        for (const template of loom()) {
            expect(String(template.summary || '').trim().length).toBeGreaterThan(10);
        }
    });

    // --- What the card menu reads -------------------------------------------

    test('every card preview is the shape the model writes, not the prose', () => {
        for (const template of loom()) {
            const preview = templatePreview(template);
            expect(preview).not.toBe('');
            expect(template.content).toContain(preview);
        }
    });

    test('the preview picks the longest shape line, so a fence identifies itself', () => {
        const fence = getPromptInstructionTemplate('loom', 'chat', 'contract.stateFence');
        const preview = templatePreview(fence);
        const shapes = fence.content.split('\n').map((line) => line.trim())
            .filter((line) => line.startsWith('{') || line.startsWith('"'));
        expect(shapes.length).toBeGreaterThan(1);
        expect(preview.length).toBe(Math.max(...shapes.map((line) => line.length)));
    });

    test('the preview survives a template with nothing shape-like in it', () => {
        expect(templatePreview({ content: 'just prose\nand more prose' })).toBe('and more prose');
        expect(templatePreview({ content: '' })).toBe('');
        expect(templatePreview(null)).toBe('');
    });

    test('filtering matches name, group, summary and body, and is case-blind', () => {
        const all = loom();
        expect(filterTemplates(all, '')).toBe(all);
        expect(filterTemplates(all, '   ')).toBe(all);
        // Body only: "lore.edit" appears in the lore ops instruction, not a label.
        expect(filterTemplates(all, 'LORE.EDIT').map((item) => item.key)).toContain('lore.ops');
        // Group name only — no template is labelled "Living Lore" itself.
        expect(filterTemplates(all, 'Living Lore').length).toBeGreaterThanOrEqual(2);
        expect(filterTemplates(all, 'zzzz-no-such-thing')).toEqual([]);
    });
});
