import {
    filterTemplates,
    getPromptInstructionTemplate,
    getPromptInstructionTemplates,
    templatePreview,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/prompt-instruction-templates.js';
import { buildMetadataGuide } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/metadata-guide.js';
import { PROMPT_ROLES, PROMPT_TEMPLATE_DEFINITIONS } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/prompt-studio-store.js';
import {
    getCapabilityDictionary,
    MECHANICS_PROTOCOL,
    REQUIRED_ARGUMENTS,
    validateMechanicsRequest,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/mechanics-capabilities.js';
import { NARRATOR_MECHANIC_TOOLS } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/mechanics-gateway.js';

const loom = () => getPromptInstructionTemplates('loom', 'chat');

describe('Prompt Studio instruction templates', () => {
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

    // --- Coverage: one per operation ---------------------------------------

    // Coverage, not order — the picker is grouped, so the sequence is asserted
    // separately by the ordering test below.
    test('the Loom picker carries an instruction for every capability', () => {
        const covered = loom().filter((template) => template.key.startsWith('operation.'))
            .map((template) => template.key.slice('operation.'.length));
        expect([...covered].sort()).toEqual(getCapabilityDictionary().map((capability) => capability.name).sort());
        expect(covered).toHaveLength(getCapabilityDictionary().length);
    });

    test('every operation template embeds a request the validator accepts', () => {
        for (const template of loom().filter((item) => item.key.startsWith('operation.'))) {
            const line = template.content.split('\n').at(-1);
            const request = JSON.parse(line);
            const result = validateMechanicsRequest({ protocol: MECHANICS_PROTOCOL, requests: [request] });
            expect({ key: template.key, errors: result.errors }).toEqual({ key: template.key, errors: [] });
            expect(request.capability).toBe(template.key.slice('operation.'.length));
        }
    });

    test('every operation template names all of that operation’s required arguments', () => {
        for (const template of loom().filter((item) => item.key.startsWith('operation.'))) {
            const name = template.key.slice('operation.'.length);
            for (const [key] of REQUIRED_ARGUMENTS[name] || []) {
                expect(`${name}:${template.content.includes(`- ${key} (`)}`).toBe(`${name}:true`);
            }
        }
    });

    test('a closed-list argument is instructed with its values, never a bare type', () => {
        const guide = buildMetadataGuide();
        let checked = 0;
        for (const capability of guide.capabilities) {
            const template = getPromptInstructionTemplate('loom', 'chat', `operation.${capability.name}`);
            for (const argument of capability.arguments) {
                if (!argument.values.length) continue;
                checked += 1;
                expect(template.content).toContain(`- ${argument.key} (${argument.values.join(' | ')})`);
            }
        }
        expect(checked).toBeGreaterThan(0);
    });

    // A heading that runs straight on from the line above it reads as part of
    // that line, which is exactly what a model does with it too.
    test('every section of an operation template is separated by a blank line', () => {
        for (const template of loom().filter((item) => item.key.startsWith('operation.'))) {
            for (const heading of ['Required arguments:', 'Optional arguments:', 'Write it exactly like this']) {
                if (!template.content.includes(heading)) continue;
                expect(`${template.key} ${heading} ${template.content.includes(`\n\n${heading}`)}`)
                    .toBe(`${template.key} ${heading} true`);
            }
        }
    });

    test('the picker is ordered the way the Loom works, Archive before consequences', () => {
        const seen = [];
        for (const template of loom()) {
            if (seen.at(-1) !== template.groupLabel) seen.push(template.groupLabel);
        }
        // Each group appears exactly once — a group split across the list means
        // the ordering is the dictionary's, not the intended one.
        expect(seen).toEqual([...new Set(seen)]);
        expect(seen.indexOf('Archive operations')).toBeLessThan(seen.indexOf('Goals'));
        expect(seen[0]).toBe('Output contract');
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

    test('the lore templates carry the shapes intake and retrieval accept', () => {
        const guide = buildMetadataGuide();
        expect(getPromptInstructionTemplate('loom', 'chat', 'lore.report').content).toContain(guide.lore.proposal.example);
        expect(getPromptInstructionTemplate('loom', 'chat', 'lore.keywords').content).toContain(guide.lore.keywords.example);
    });

    // --- Per-mode availability ---------------------------------------------

    test('the Narrator verbs are carried, and none of them mentions a fence', () => {
        const verbs = loom().filter((template) => template.group === 'narrator');
        expect(verbs.map((template) => template.key.replace('narrator.', ''))).toEqual([...NARRATOR_MECHANIC_TOOLS]);
        for (const template of verbs) expect(template.content).not.toContain('```state');
    });

    // The picker is not a permission system: recipes belong to the owner, and a
    // template a mode hides cannot be talked into appearing.
    test('every mode and api type is offered the same templates', () => {
        const reference = loom().map((template) => template.key);
        expect(reference.length).toBeGreaterThan(20);
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
        expect(getPromptInstructionTemplate('loom', 'chat', 'operation.goal.create')).not.toBeNull();
        expect(getPromptInstructionTemplate('story', 'text', 'operation.goal.create')).not.toBeNull();
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
            // The identifying line, not the fence opener it happens to start on.
            expect(preview).not.toBe('{"requests":[');
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
        expect(filterTemplates(all, 'GOAL.REACH').map((item) => item.key)).toContain('operation.goal.reach');
        // Group name only — no template is labelled "Living Lore" itself.
        expect(filterTemplates(all, 'Living Lore').length).toBeGreaterThan(2);
        // Body only: this phrase appears in the instruction, not the label.
        expect(filterTemplates(all, 'never state the outcome yourself').length).toBeGreaterThan(0);
        expect(filterTemplates(all, 'zzzz-no-such-thing')).toEqual([]);
    });
});
