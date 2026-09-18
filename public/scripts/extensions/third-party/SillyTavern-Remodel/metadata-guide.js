// Exactly what a model has to put down.
//
// Prose is the only part of a reply that arrives on its own. Every other effect
// — an Archive event, a Goal, a Variable, durable lore, a retrieval — happens
// because a model emitted a specific shape and code recognised it. None of them
// fail loudly: get a shape wrong and the prose still commits while the effect
// silently never happens.
//
// So this is a paste reference, not a dictionary. Every operation carries the
// exact request line that runs it, because "loreHint — the typed relation" tells
// a model nothing: the code accepts three words and no others, and a guide that
// names an argument without naming its values has documented nothing.
//
// GENERATED, NOT WRITTEN. Names, types and every allowed enum value are read out
// of getMechanicsRequestSchema() — the same schema the provider is sent — and
// the required-argument lists come from REQUIRED_ARGUMENTS, the table
// validateArguments throws against. The example lines are authored, and the
// suite re-validates each one through the real validator, so an example that
// stops being accepted fails a test instead of misleading a recipe.
//
// Pure: data only, no DOM, no store, no network. The Debug Console renders it.

import { getCapabilityDictionary, getMechanicsRequestSchema, REQUIRED_ARGUMENTS } from './mechanics-capabilities.js';
import { MAX_LORE_KEYWORDS, MAX_LORE_KEYWORD_GROUPS, MAX_LORE_OPS } from './loom-reconciliation.js';
import { buildProviderToolDefinitions, NARRATOR_MECHANIC_TOOLS } from './mechanics-gateway.js';

export function buildMetadataGuide() {
    return Object.freeze({
        fence: fence(),
        envelope: envelope(),
        surfaces: surfaces(),
        capabilities: capabilities(),
        lore: lore(),
        narrator: narrator(),
    });
}

// --- The fence --------------------------------------------------------------

function fence() {
    return Object.freeze({
        opener: '```state',
        example: [
            '```state',
            '{"requests":[',
            '  {"id":"r1","capability":"goal.edit","arguments":{"goalRef":"Reach the lighthouse before dawn","successRate":23},"reason":"the accepted prose changed his odds"}',
            '],"loreKeywords":[],"loreOps":[],"flow":{"continue":false}}',
            '```',
        ].join('\n'),
    });
}

// --- Top-level keys ---------------------------------------------------------

function envelope() {
    return Object.freeze([
        key('requests', 'array', 'Goal and Variable mechanics operations, one advertised capability each.',
            '"requests":[{"id":"r1","capability":"goal.edit","arguments":{"goalRef":"Reach the lighthouse before dawn","successRate":23},"reason":"why, one line"}]'),
        key('loreKeywords', 'array', 'Keyword groups that pull more working lore for this scene. Omit it to keep what is there.',
            '"loreKeywords":[["Queens Lake University"],["event","Marissa"]]'),
        key('loreOps', 'array', 'Typed edits/creations against Living Lore entries. Empty unless accepted fiction changed a scoped entry or established a new durable subject.',
            '"loreOps":[{"id":"o1","op":"lore.edit","arguments":{"book":"TL","uid":"1","content":"..."},"reason":"why"}]'),
        key('flow', 'object', 'Whether the turn continues. Absent means neither.',
            '"flow":{"continue":false,"hardPause":false}'),
        key('swaps', 'array', 'Patch contract only, and only applied when the reply carries no prose.',
            '"swaps":[{"find":"exact text from the draft","replace":"what it becomes"}]'),
    ]);
}

function key(name, type, purpose, example) {
    return Object.freeze({ name, type, purpose, example });
}

// --- Which surface accepts what --------------------------------------------

/**
 * One surface. The live Roleplay Loom reconciles a draft and may request the
 * full dictionary of Goal and Variable operations. The background Archive is
 * dissolved, so there is no second background-ingestion surface.
 */
function surfaces() {
    const all = getCapabilityDictionary().map((capability) => capability.name);
    return Object.freeze([
        surface('roleplay-loom', 'Roleplay Loom', 'Loom recipe, live reconciliation', all,
            'The full dictionary of Goal and Variable operations the Loom may request.'),
    ]);
}

function surface(id, label, recipe, accepts, note) {
    return Object.freeze({ id, label, recipe, accepts: Object.freeze(accepts), note });
}

// --- Operations -------------------------------------------------------------

/**
 * The optional arguments worth showing per capability. The required ones come
 * from REQUIRED_ARGUMENTS; these are the ones a capability exists to carry but
 * can run without. goal.edit's whole purpose is its optional fields, so listing
 * only its required goalRef would describe a capability that does nothing.
 *
 * Authored, then checked: the suite asserts every key here is a real property of
 * the request schema, so a renamed argument fails a test rather than sitting
 * here pointing at nothing.
 */
const OPTIONAL_ARGUMENTS = Object.freeze({
    'goal.create': Object.freeze(['targetRefs', 'successRate', 'visibility', 'alias']),
    'goal.edit': Object.freeze(['title', 'description', 'successRate', 'status', 'visibility']),
    'goal.reach': Object.freeze(['impact']),
    'variable.create': Object.freeze(['enumValues', 'minimum', 'maximum', 'alias']),
    'variable.adjust': Object.freeze(['field']),
    'variable.transition': Object.freeze(['field']),
    'modifier.add': Object.freeze(['endingCondition']),
});

/** One runnable request per capability, as the model would emit it. */
const EXAMPLE_ARGUMENTS = Object.freeze({
    'goal.create': {
        title: 'Reach the lighthouse before dawn',
        description: 'On track while Teo keeps moving north and the keeper stays unaware; broken if he is seen, or if dawn breaks first.',
        holderRefs: [{ kind: 'character', id: 'Teo Alvarez', label: 'Teo Alvarez' }],
        successRate: 45,
    },
    'goal.edit': { goalRef: 'Reach the lighthouse before dawn', successRate: 23, status: 'active' },
    'goal.delete': { goalRef: 'Reach the lighthouse before dawn' },
    'goal.reach': { goalRef: 'Reach the lighthouse before dawn' },
    'goal.relate': { fromGoalRef: 'Reach the lighthouse before dawn', toGoalRef: 'Keep the keeper asleep', type: 'sympathetic' },
    'goal.lore.attach': { goalRef: 'Reach the lighthouse before dawn', loreBook: 'Queens Lake', loreUid: '42', loreRevision: 1, loreType: 'subject' },
    'goal.lore.detach': { goalRef: 'Reach the lighthouse before dawn', loreBook: 'Queens Lake', loreUid: '42', loreRevision: 1 },
    'variable.create': {
        name: 'Teo\'s Resolve',
        valueType: 'number',
        value: 6,
        description: 'How much fight Teo has left before he starts making mistakes.',
        minimum: 0,
        maximum: 10,
    },
    'variable.set': { variableRef: 'Teo\'s Resolve', value: 4 },
    'variable.adjust': { variableRef: 'Teo\'s Resolve', delta: -2 },
    'variable.transition': { variableRef: 'Keeper\'s Watch', nextState: 'suspicious' },
    'variable.subvalue.set': { variableRef: 'Teo\'s Resolve', field: 'nerve', value: 3 },
    'variable.lore.attach': { variableRef: 'Teo\'s Resolve', loreBook: 'Queens Lake', loreUid: '42', loreRevision: 1, loreHint: 'subject' },
    'variable.lore.detach': { variableRef: 'Teo\'s Resolve', loreBook: 'Queens Lake', loreUid: '42', loreRevision: 1 },
    'modifier.add': { variableRef: 'Teo\'s Resolve', label: 'Wounded', delta: -2, target: 'value', endingCondition: 'until the wound is dressed' },
    'modifier.remove': { variableRef: 'Teo\'s Resolve', modifierId: 'mod-7f2a' },
});

const EXAMPLE_REASONS = Object.freeze({
    'goal.reach': 'a decisive attempt whose outcome is genuinely uncertain',
    'goal.delete': 'this Goal should not exist at all, rather than having ended',
});

function capabilities() {
    const properties = argumentProperties();
    return Object.freeze(getCapabilityDictionary().map((capability) => {
        const required = (REQUIRED_ARGUMENTS[capability.name] || []).map(([name]) => name);
        const optional = OPTIONAL_ARGUMENTS[capability.name] || [];
        return Object.freeze({
            name: capability.name,
            group: capability.name.split('.')[0],
            description: capability.description,
            arguments: Object.freeze([
                ...required.map((name) => argument(name, properties, true, hintFor(capability.name, name))),
                ...optional.map((name) => argument(name, properties, false, '')),
            ]),
            example: exampleRequest(capability.name),
        });
    }));
}

/** The one runnable line, formatted the way it belongs inside "requests". */
function exampleRequest(name) {
    return JSON.stringify({
        id: 'r1',
        capability: name,
        arguments: EXAMPLE_ARGUMENTS[name] || {},
        reason: EXAMPLE_REASONS[name] || 'why the accepted fiction warrants this',
    });
}

function hintFor(capability, key) {
    const entry = (REQUIRED_ARGUMENTS[capability] || []).find(([name]) => name === key);
    return entry ? entry[1] : '';
}

/**
 * The argument properties of the request schema, flattened. This is where the
 * allowed values live — a key described as "the typed relation" is five exact
 * words in the schema, and those words are what the model needs.
 */
function argumentProperties() {
    const schema = getMechanicsRequestSchema();
    return schema?.schema?.properties?.requests?.items?.properties?.arguments?.properties || {};
}

function argument(key, properties, required, hint) {
    const property = properties[key] || {};
    return Object.freeze({
        key,
        required,
        type: describeType(property),
        values: Object.freeze(allowedValues(property)),
        hint: hint || String(property.description || ''),
    });
}

function describeType(property) {
    if (property.type === 'array') {
        return `array of ${property.items?.type === 'object' ? 'objects' : `${property.items?.type || 'string'}s`}`;
    }
    if (Array.isArray(property.type)) return property.type.join(' | ');
    return String(property.type || 'string');
}

function allowedValues(property) {
    if (Array.isArray(property.enum)) return [...property.enum];
    if (Array.isArray(property.items?.enum)) return [...property.items.enum];
    // holderRefs / targetRefs hold objects; their kind field is the closed list
    // that actually constrains what may be written.
    const kinds = property.items?.properties?.kind?.enum;
    return Array.isArray(kinds) ? [...kinds] : [];
}

// --- Living Lore ------------------------------------------------------------

function lore() {
    return Object.freeze({
        ops: Object.freeze({
            example: JSON.stringify({
                loreOps: [
                    { id: 'o1', op: 'lore.edit', arguments: { book: 'TL', uid: '1', content: 'The lighthouse has run unmanned on a timer since the keeper died.' }, reason: 'the keeper is confirmed dead' },
                    { id: 'o2', op: 'lore.create', arguments: { name: 'Queens Lake Lighthouse', keys: ['Queens Lake Lighthouse', 'the lighthouse'], content: 'A coastal light north of the town, automated.' }, reason: 'a new durable place' },
                ],
            }),
            arguments: Object.freeze([
                field('op', 'string', true, 'Either "lore.edit" (rewrite an entry already in the Selected Living Lore) or "lore.create" (add a new entry to the timeline book).'),
                field('book', 'string', false, 'lore.edit only: the entry\'s book, exactly as the Selected Living Lore names it.'),
                field('uid', 'string', false, 'lore.edit only: the entry\'s uid within that book.'),
                field('name', 'string', false, 'lore.create only: a short title for the new entry.'),
                field('keys', 'array of strings', false, 'lore.create only: the exact trigger keywords the new entry answers to.'),
                field('content', 'string', true, 'The full entry text after the change. Capped; longer content is truncated, not rejected.'),
            ]),
            note: `Up to ${MAX_LORE_OPS} ops per turn. Edit only an entry that is in the Selected Living Lore; to change one that is not, first name its key in loreKeywords to pull it in. A lore.edit whose book/uid is not in scope is refused.`,
        }),
        keywords: Object.freeze({
            example: JSON.stringify({ loreKeywords: [['Queens Lake University'], ['event', 'Marissa']] }),
            arguments: Object.freeze([
                field('loreKeywords', 'array of keyword groups', false, `Up to ${MAX_LORE_KEYWORD_GROUPS} groups of up to ${MAX_LORE_KEYWORDS} keys each. Must be the exact key an entry answers to — "Queens" will not find "Queens Lake University". An entry needing several keys is pulled only when they are named together in one group.`),
            ]),
            note: 'What you pull stays available for the scene. It is not a per-turn top-up.',
        }),
    });
}

function field(key, type, required, hint, values = []) {
    return Object.freeze({ key, type, required, values: Object.freeze([...values]), hint });
}

// --- The Narrator side ------------------------------------------------------

const NARRATOR_EXAMPLE_ARGUMENTS = Object.freeze({
    'goal.attempt': { actor: 'Teo Alvarez', target: 'Reach the lighthouse before dawn', stakes: 'the keeper wakes', reason: 'he is committing to the stair' },
    'goal.adjust': { actor: 'Teo Alvarez', target: 'Reach the lighthouse before dawn', value: 30, reason: 'the door gave way sooner than expected' },
    'variable.adjust': { actor: 'Teo Alvarez', target: 'Teo\'s Resolve', value: -2, reason: 'the wound is telling on him' },
    'mechanic.check': { actor: 'Teo Alvarez', target: 'Teo\'s Resolve', reason: 'he needs to know whether he can hold on' },
});

/** Not a fence: these are provider tool calls, with their own argument schema. */
function narrator() {
    const definitions = new Map(buildProviderToolDefinitions(NARRATOR_MECHANIC_TOOLS)
        .map((definition) => [definition.function.name, definition.function]));
    return Object.freeze({
        tools: Object.freeze(NARRATOR_MECHANIC_TOOLS.map((name) => {
            const definition = definitions.get(name) || {};
            const properties = definition.parameters?.properties || {};
            const required = new Set(definition.parameters?.required || []);
            return Object.freeze({
                name,
                description: definition.description || '',
                arguments: Object.freeze(Object.keys(properties).map((key) => argument(key, properties, required.has(key), ''))),
                example: JSON.stringify(NARRATOR_EXAMPLE_ARGUMENTS[name] || {}),
            });
        })),
    });
}
