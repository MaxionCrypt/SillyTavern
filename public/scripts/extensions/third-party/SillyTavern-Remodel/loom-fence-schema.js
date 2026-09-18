// Provider-enforced schema for the Roleplay Loom's state fence.
//
// This is the experimental structured-output contract: instead of teaching the
// model the fence shape in prose and hoping it complies, we hand the provider a
// JSON schema and it *cannot* return a malformed request. The reply comes back
// as bare JSON (no ```state fence), which readLoomEnvelope already recovers as
// 'bare-json-recovered' — so nothing on the parse side changes.
//
// SCOPE, on purpose (owner's instruction): only GOAL operations are enforced
// here. A strict JSON schema cannot enforce one capability's arguments while
// leaving another capability's arguments free — strict mode demands every
// property be listed and required. So enforcing goal.* strictly means NARROWING
// the capability set this schema permits to Goals alone. Everything else
// (variable.*, modifier.*, lore attach/detach) is dropped until its own schema
// is built. That is the honest cost of "provider-enforced, goal only": while
// this schema is on, the Loom can do Goals and nothing else.
//
// The argument descriptions are pulled from getMechanicsRequestSchema() so the
// wording stays the single source of truth the validator and the Loom prompt
// already share — this module never re-writes what a field means, it only
// selects and groups the goal-relevant ones and marks which are optional.

import { getMechanicsRequestSchema } from './mechanics-capabilities.js';

/** The capabilities this experimental schema permits: Goal ops only.
 *  Exported so a test can assert the boundary is exactly this. */
export const ROLEPLAY_LOOM_GOAL_CAPABILITIES = Object.freeze([
    'goal.create', 'goal.edit', 'goal.delete', 'goal.reach', 'goal.relate',
]);

/** Per capability: which arguments are required, and which are optional. Every
 *  listed argument is enforced (strict mode requires it in `required`); optional
 *  ones are made nullable so "not applicable this request" is expressible. */
const GOAL_REQUEST_SHAPES = Object.freeze({
    'goal.create': { required: ['title', 'description', 'holderRefs'], optional: ['alias', 'targetRefs', 'successRate', 'visibility'] },
    'goal.edit': { required: ['goalRef'], optional: ['title', 'description', 'successRate', 'status', 'visibility'] },
    'goal.delete': { required: ['goalRef'], optional: [] },
    'goal.reach': { required: ['goalRef'], optional: ['modifierVariableRef', 'impact'] },
    'goal.relate': { required: ['fromGoalRef', 'toGoalRef', 'type'], optional: [] },
});

/** Per capability: the typed lore operations the Loom may emit. lore.edit
 *  rewrites a cached entry's content; lore.create adds a new entry to the
 *  timeline's bound book. Import needs no op — it is a keyword retrieval. */
const LORE_OP_CAPABILITIES = Object.freeze(['lore.edit', 'lore.create']);
const LORE_OP_SHAPES = Object.freeze({
    'lore.edit': { required: ['book', 'uid', 'content'], optional: ['secret'] },
    'lore.create': { required: ['name', 'keys', 'content'], optional: ['secondaryKeys', 'secret'] },
});
const LORE_ARG_PROPS = Object.freeze({
    book: { type: 'string', description: 'The lorebook the entry lives in (from a Selected Living Lore target).' },
    uid: { type: 'string', description: 'The entry id within that book (from a Selected Living Lore target).' },
    content: { type: 'string', description: 'The full new content for the entry.' },
    name: { type: 'string', description: 'A short title for the new entry.' },
    keys: { type: 'array', items: { type: 'string' }, description: 'Trigger keywords the new entry answers to.' },
    secondaryKeys: { type: 'array', items: { type: 'string' }, description: 'Extra keys that must also be present for the entry to trigger.' },
    secret: { type: 'boolean', description: 'True hides the entry from the Narrator (Loom-only); false reveals a hidden entry. Null leaves its visibility unchanged.' },
});

/** Add 'null' to a JSON-schema type so an optional argument can be omitted as
 *  null. Enums also gain a null member, since strict mode reads type and enum
 *  together. */
function nullable(descriptor) {
    const baseType = descriptor.type || 'string';
    const type = Array.isArray(baseType) ? [...baseType, 'null'] : [baseType, 'null'];
    const out = { ...descriptor, type };
    if (Array.isArray(descriptor.enum)) out.enum = [...descriptor.enum, null];
    return out;
}

/**
 * Build the provider-enforced schema for the Roleplay Loom fence, goal-scoped.
 * Returns the repo descriptor shape ({ name, strict, schema }); pass it through
 * toCoreJsonSchema() before handing it to the request path.
 */
export function getRoleplayLoomGoalSchema() {
    const mechanics = getMechanicsRequestSchema().schema.properties.requests.items.properties;
    const argProps = mechanics.arguments.properties;
    const idDescriptor = mechanics.id;
    const reasonDescriptor = mechanics.reason;

    const requestBranch = (capability) => {
        const { required, optional } = GOAL_REQUEST_SHAPES[capability];
        const properties = {};
        for (const key of required) properties[key] = argProps[key];
        for (const key of optional) properties[key] = nullable(argProps[key]);
        return {
            type: 'object', additionalProperties: false,
            required: ['id', 'capability', 'arguments', 'reason'],
            properties: {
                id: idDescriptor,
                capability: { type: 'string', enum: [capability], description: `Always "${capability}" for this request.` },
                arguments: {
                    type: 'object', additionalProperties: false,
                    required: [...required, ...optional],
                    properties,
                },
                reason: reasonDescriptor,
            },
        };
    };

    const loreOpBranch = (capability) => {
        const { required, optional } = LORE_OP_SHAPES[capability];
        const properties = {};
        for (const key of required) properties[key] = LORE_ARG_PROPS[key];
        for (const key of optional) properties[key] = nullable(LORE_ARG_PROPS[key]);
        return {
            type: 'object', additionalProperties: false,
            required: ['id', 'op', 'arguments', 'reason'],
            properties: {
                id: idDescriptor,
                op: { type: 'string', enum: [capability], description: `Always "${capability}" for this op.` },
                arguments: {
                    type: 'object', additionalProperties: false,
                    required: [...required, ...optional],
                    properties,
                },
                reason: reasonDescriptor,
            },
        };
    };

    return {
        name: 'remodel_roleplay_loom_goal',
        description: "The Roleplay Loom's state fence: swaps, goal requests, lore, and flow. Goal requests are provider-enforced.",
        strict: true,
        schema: {
            type: 'object', additionalProperties: false,
            required: ['swaps', 'requests', 'loreKeywords', 'loreOps', 'flow'],
            properties: {
                swaps: {
                    type: 'array', maxItems: 16,
                    description: 'Find/replace spans against the Narrator draft. Empty leaves the draft untouched.',
                    items: {
                        type: 'object', additionalProperties: false, required: ['find', 'replace'],
                        properties: {
                            find: { type: 'string', minLength: 1, description: 'Exact text in the draft to replace.' },
                            replace: { type: 'string', description: 'What it becomes; an empty string deletes the span.' },
                        },
                    },
                },
                requests: {
                    type: 'array', maxItems: 32,
                    description: 'The batch of goal operations for this turn. Empty when nothing changed.',
                    items: { anyOf: ROLEPLAY_LOOM_GOAL_CAPABILITIES.map(requestBranch) },
                },
                loreKeywords: {
                    type: 'array', maxItems: 8,
                    description: 'Keyword GROUPS to pull working lore for the turns that follow. Each group is an array of the exact keys an entry answers to; an entry that needs several keys is found only when they are named together in one group. Empty for no change.',
                    items: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string' } },
                },
                loreOps: {
                    type: 'array', maxItems: 16,
                    description: 'Typed lore edits/creations for this turn. Edit an entry only when it is in the Selected Living Lore; create a new entry in the timeline book. Empty when nothing changed.',
                    items: { anyOf: LORE_OP_CAPABILITIES.map(loreOpBranch) },
                },
                flow: {
                    type: 'object', additionalProperties: false, required: ['continue', 'hardPause'],
                    description: 'Turn flow after this reply.',
                    properties: {
                        continue: { type: 'boolean', description: 'Whether the scene should continue immediately.' },
                        hardPause: { type: 'boolean', description: 'Whether to stop and wait for the user regardless.' },
                    },
                },
            },
        },
    };
}
