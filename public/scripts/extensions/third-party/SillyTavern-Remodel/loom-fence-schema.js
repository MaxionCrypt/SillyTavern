// Provider-enforced schema for the Roleplay Loom's state fence.
//
// This is the experimental structured-output contract: instead of teaching the
// model the fence shape in prose and hoping it complies, we hand the provider a
// JSON schema and it *cannot* return a malformed reply. The reply comes back as
// bare JSON (no ```state fence), which readLoomEnvelope already recovers as
// 'bare-json-recovered' — so nothing on the parse side changes.
//
// The fence carries: swaps (patch the draft), loreKeywords (replace the working
// lore set), loreOps (typed edit/create of Living Lore entries), and flow. The
// Loom's Goal/Variable mechanics are dissolved; those are ordinary Living Lore
// entries now, changed through loreOps like any other entry.

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

// The shared id/reason descriptors every fence op carries. Defined locally now
// that the dissolved mechanics schema no longer supplies them.
const ID_DESCRIPTOR = Object.freeze({ type: 'string', description: 'A short unique id for this op within the reply, e.g. "o1".' });
const REASON_DESCRIPTOR = Object.freeze({ type: 'string', description: 'Why, in one line.' });

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
 * Lift a repo schema descriptor ({ name, description, strict, schema }) to the
 * core structured-output shape ({ name, description, strict, value }). Core reads
 * `.value`; handing it a bare schema ships a request with no schema in it and the
 * model invents a reply shape. Always cross that boundary through here.
 */
export function toCoreJsonSchema(descriptor) {
    return {
        name: descriptor?.name || 'remodel_structured_reply',
        description: descriptor?.description || 'Well-formed JSON object',
        strict: descriptor?.strict !== false,
        value: descriptor?.schema,
    };
}

/**
 * Build the provider-enforced schema for the Roleplay Loom fence.
 * Returns the repo descriptor shape ({ name, strict, schema }); pass it through
 * toCoreJsonSchema() before handing it to the request path.
 */
export function getRoleplayLoomGoalSchema() {
    const loreOpBranch = (capability) => {
        const { required, optional } = LORE_OP_SHAPES[capability];
        const properties = {};
        for (const key of required) properties[key] = LORE_ARG_PROPS[key];
        for (const key of optional) properties[key] = nullable(LORE_ARG_PROPS[key]);
        return {
            type: 'object', additionalProperties: false,
            required: ['id', 'op', 'arguments', 'reason'],
            properties: {
                id: ID_DESCRIPTOR,
                op: { type: 'string', enum: [capability], description: `Always "${capability}" for this op.` },
                arguments: {
                    type: 'object', additionalProperties: false,
                    required: [...required, ...optional],
                    properties,
                },
                reason: REASON_DESCRIPTOR,
            },
        };
    };

    return {
        name: 'remodel_roleplay_loom_goal',
        description: "The Roleplay Loom's state fence: swaps, lore keywords, lore ops, and flow.",
        strict: true,
        schema: {
            type: 'object', additionalProperties: false,
            required: ['swaps', 'loreKeywords', 'loreOps', 'flow'],
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
