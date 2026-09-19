// Templates worth having in Prompt Studio.
//
// What used to sit behind "Add template" was one entry per macro — a message
// whose whole body was `{{character.description}}`. The macro reference two
// rows below the button already lists every one of those and inserts it at the
// cursor, so the picker was a second copy of a list the editor already had, and
// neither copy told anyone how to instruct a model.
//
// A template should be the part you cannot look up: the exact wording that
// teaches a model to emit a shape code will actually accept. So these are the
// state fence and the Living Lore contracts — each carrying its required
// arguments, its allowed values, and an example line that runs.
//
// GENERATED from metadata-guide.js, which reads the schema the provider is sent
// and the table validateArguments throws against. Writing these by hand would
// reproduce the defect the guide exists to prevent, one copy further from the
// code: an instruction that names an argument the validator does not want, or
// omits one it demands, reads exactly like a working template.

import { buildMetadataGuide } from './metadata-guide.js';

/** Groups shown in the picker, in this order. */
const GROUP_LABELS = Object.freeze({
    contract: 'Output contract',
    lore: 'Living Lore',
});

/**
 * Every instruction template, for every recipe.
 *
 * Deliberately ungated. An earlier version offered the contract only to Loom
 * recipes and the verbs only to Roleplay chat, on the reasoning that a Story
 * recipe emitting a state fence would put backticks in the manuscript. That
 * reasoning still holds — it is just not the picker's call to make. Recipes are
 * the owner's, the modes are not a permission system, and a picker that hides
 * a template cannot be talked into showing it.
 *
 * What is true, and worth knowing rather than enforcing: a fence emitted by a
 * Story prose recipe is parsed by nothing and lands in the manuscript.
 *
 * @param {string} mode kept for call-site symmetry; every mode gets everything
 * @param {string} apiType same
 */
export function getPromptInstructionTemplates(mode, apiType = 'chat') {
    const guide = buildMetadataGuide();
    return Object.freeze(byGroup([
        ...contractTemplates(guide),
        ...loreTemplates(guide),
    ]));
}

/**
 * Ordered by GROUP_LABELS — the output contract first, then Living Lore —
 * rather than by the order the templates happen to arrive in.
 */
function byGroup(templates) {
    const order = Object.keys(GROUP_LABELS);
    return [...templates].sort((left, right) => order.indexOf(left.group) - order.indexOf(right.group));
}

/** One template by key, or null. */
export function getPromptInstructionTemplate(mode, apiType, key) {
    return getPromptInstructionTemplates(mode, apiType).find((template) => template.key === key) || null;
}

// --- The contract -----------------------------------------------------------

function contractTemplates(guide) {
    const keys = guide.envelope.map((item) => `- "${item.name}" — ${item.purpose}\n  ${item.example}`).join('\n');
    return [
        instruction('contract.stateFence', 'State fence (full contract)', 'contract', 'system',
            'The envelope itself, with every top-level key and what each one carries.', [
                'Output NOTHING except one state fence. Do not restate the prose.',
                '',
                guide.fence.example,
                '',
                'Top-level keys:',
                keys,
                '',
                'Every op is its own object. Close one with } and open the next with {. Never repeat "id" inside a single object.',
            ].join('\n')),
        instruction('contract.flow', 'Flow control', 'contract', 'system',
            'How to ask for another turn, or to stop and wait for the player.', [
                'Set "flow" when this turn should not simply end.',
                '"flow":{"continue":true} asks for another turn immediately.',
                '"flow":{"hardPause":true} stops the scene and waits for the player.',
                'Omit "flow" entirely when neither applies.',
            ].join('\n')),
    ];
}

// --- Describing arguments ---------------------------------------------------

function describeArgument(argument) {
    const shape = argument.values.length ? argument.values.join(' | ') : argument.type;
    return `- ${argument.key} (${shape}) — ${argument.hint}`;
}

// --- Living Lore ------------------------------------------------------------

function loreTemplates(guide) {
    return [
        instruction('lore.ops', 'Living Lore edits', 'lore', 'system',
            'How to edit a scoped entry or create a new one through typed loreOps.', [
                'When accepted fiction changes a Selected Living Lore entry, rewrite it with a "lore.edit" op in a top-level "loreOps" array. When it establishes a durable new subject, add a "lore.create" op.',
                '',
                ...guide.lore.ops.arguments.map(describeArgument),
                '',
                guide.lore.ops.note,
                '',
                'One op is one change. Split unrelated changes into separate ops.',
                'Use "loreOps":[] when the fiction changed nothing durable.',
                '',
                'Shape:',
                guide.lore.ops.example,
            ].join('\n')),
        instruction('lore.keywords', 'Retrieval keywords', 'lore', 'system',
            'How to replace the working lore when the scene has moved on.', [
                'The Selected Living Lore above is what this scene is working from, and it stays until you replace it.',
                'When the scene has moved on far enough that it no longer fits, add a top-level "loreKeywords" array naming what to look up instead.',
                '',
                ...guide.lore.keywords.arguments.map(describeArgument),
                '',
                guide.lore.keywords.note,
                'Leave "loreKeywords" out when the current lore still serves.',
                '',
                'Shape:',
                guide.lore.keywords.example,
            ].join('\n')),
    ];
}

// --- Shape ------------------------------------------------------------------

function instruction(key, label, group, role, summary, content) {
    return Object.freeze({
        key,
        label,
        group,
        groupLabel: GROUP_LABELS[group] || group,
        role,
        summary,
        content,
    });
}

// --- Reading the list -------------------------------------------------------

/** Free-text filter across everything a card shows plus the body it inserts. */
export function filterTemplates(templates, query) {
    const needle = String(query || '').trim().toLowerCase();
    if (!needle) return templates;
    return templates.filter((template) => [template.label, template.groupLabel, template.summary, template.content]
        .join(' ').toLowerCase().includes(needle));
}

/**
 * The one line on a card that shows what the model ends up writing, rather than
 * the prose explaining it. The LONGEST shape-looking line, not the first: a
 * fence template opens on `{"swaps":[`, which identifies nothing.
 */
export function templatePreview(template) {
    const lines = String(template?.content || '').split('\n').map((line) => line.trim()).filter(Boolean);
    const shapes = lines.filter((line) => line.startsWith('{') || line.startsWith('"'));
    return shapes.sort((left, right) => right.length - left.length)[0] || lines.at(-1) || '';
}
