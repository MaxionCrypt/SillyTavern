import { __setExtensionSettings } from './util/st-context-stub.js';
import { getRoleplayLoomGoalSchema, ROLEPLAY_LOOM_GOAL_CAPABILITIES } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/loom-fence-schema.js';
import { toCoreJsonSchema } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/mechanics-capabilities.js';
import { parseLoomReply } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/loom-reconciliation.js';

beforeEach(() => __setExtensionSettings({ remodel: {} }));

/** Walk every object node and collect strict-mode violations. Provider strict
 *  mode demands additionalProperties:false and every property present in
 *  `required`; a stray or missing key makes the whole request non-conformant. */
function strictViolations(node, path = 'root', out = []) {
    if (!node || typeof node !== 'object') return out;
    if (node.type === 'object' && node.properties) {
        if (node.additionalProperties !== false) out.push(`${path}: missing additionalProperties:false`);
        const props = Object.keys(node.properties);
        const req = node.required || [];
        for (const p of props) if (!req.includes(p)) out.push(`${path}: "${p}" not required`);
        for (const r of req) if (!props.includes(r)) out.push(`${path}: required "${r}" has no property`);
        for (const p of props) strictViolations(node.properties[p], `${path}.${p}`, out);
    }
    if (node.items?.anyOf) node.items.anyOf.forEach((b, i) => strictViolations(b, `${path}[]#${i}`, out));
    else if (node.items) strictViolations(node.items, `${path}[]`, out);
    if (node.anyOf) node.anyOf.forEach((b, i) => strictViolations(b, `${path}#${i}`, out));
    return out;
}

const branchesByCapability = () => {
    const map = new Map();
    for (const branch of getRoleplayLoomGoalSchema().schema.properties.requests.items.anyOf) {
        map.set(branch.properties.capability.enum[0], branch);
    }
    return map;
};

test('the whole schema is strict-mode valid', () => {
    expect(strictViolations(getRoleplayLoomGoalSchema().schema)).toEqual([]);
});

test('loreKeywords is an array of string-array groups', () => {
    const kw = getRoleplayLoomGoalSchema().schema.properties.loreKeywords;
    expect(kw.type).toBe('array');
    expect(kw.items.type).toBe('array');
    expect(kw.items.items.type).toBe('string');
});

test('the top-level fence carries exactly the five state-fence keys', () => {
    const schema = getRoleplayLoomGoalSchema().schema;
    expect(new Set(Object.keys(schema.properties)))
        .toEqual(new Set(['swaps', 'requests', 'loreKeywords', 'loreOps', 'flow']));
});

test('loreOps declares strict edit and create branches', () => {
    const schema = getRoleplayLoomGoalSchema().schema;
    expect(schema.required).toContain('loreOps');
    const caps = schema.properties.loreOps.items.anyOf.map((b) => b.properties.op.enum[0]).sort();
    expect(caps).toEqual(['lore.create', 'lore.edit']);
    const edit = schema.properties.loreOps.items.anyOf.find((b) => b.properties.op.enum[0] === 'lore.edit');
    // Strict mode lists every property in `required`; the optional `secret` is
    // present-but-nullable so a visibility change can be omitted as null.
    expect(edit.properties.arguments.required).toEqual(['book', 'uid', 'content', 'secret']);
    expect(edit.properties.arguments.properties.secret.type).toEqual(['boolean', 'null']);
});

test('only goal operations plus the two bookkeeping ops are permitted — no variable/scene/etc.', () => {
    const permitted = [...branchesByCapability().keys()].sort();
    expect(permitted).toEqual([...ROLEPLAY_LOOM_GOAL_CAPABILITIES].sort());
    // The boundary that matters: nothing variable/scene/secret/char_state/modifier/lore leaked in.
    for (const capability of permitted) {
        expect(capability.startsWith('variable.')).toBe(false);
        expect(capability.startsWith('scene.')).toBe(false);
        expect(capability.startsWith('secret.')).toBe(false);
        expect(capability.startsWith('char_state.')).toBe(false);
        expect(capability.startsWith('modifier.')).toBe(false);
        expect(capability.endsWith('.lore.attach')).toBe(false);
    }
});

test('goal.create hard-requires title, description, and holderRefs', () => {
    const args = branchesByCapability().get('goal.create').properties.arguments;
    expect(args.required).toEqual(expect.arrayContaining(['title', 'description', 'holderRefs']));
    // And every listed argument resolves to a real descriptor with a type
    // (a mis-picked key from the source schema would surface as undefined here).
    const typeless = Object.entries(args.properties).filter(([, d]) => !d || d.type === undefined).map(([k]) => k);
    expect(typeless).toEqual([]);
});

test('optional arguments are nullable so "not applicable" is expressible', () => {
    const create = branchesByCapability().get('goal.create').properties.arguments.properties;
    // successRate is optional on create; its type must admit null.
    const rateType = create.successRate.type;
    expect(Array.isArray(rateType) ? rateType : [rateType]).toContain('null');
    // holderRefs is required on create; it must NOT be nullable.
    const holderType = create.holderRefs.type;
    expect(Array.isArray(holderType) ? holderType : [holderType]).not.toContain('null');
});

test('goal.reach requires goalRef and keeps impact optional', () => {
    const args = branchesByCapability().get('goal.reach').properties.arguments;
    expect(args.required).toContain('goalRef');
    const impactType = args.properties.impact.type;
    expect(Array.isArray(impactType) ? impactType : [impactType]).toContain('null');
});

test('toCoreJsonSchema lifts the descriptor to core shape the request path forwards', () => {
    const descriptor = getRoleplayLoomGoalSchema();
    const core = toCoreJsonSchema(descriptor);
    expect(core.name).toBe('remodel_roleplay_loom_goal');
    expect(core.strict).toBe(true);
    expect(core.value).toBe(descriptor.schema);
});

test('a bare-JSON reply shaped by the schema round-trips through parseLoomReply', () => {
    // Structured output returns bare JSON, no ```state fence. The existing
    // parser must recover it — this proves the wiring needs no parser change.
    const reply = JSON.stringify({
        swaps: [{ find: 'the door', replace: 'the iron door' }],
        requests: [
            { id: 'r1', capability: 'goal.edit', arguments: { goalRef: 'Escape the compound', successRate: 40 }, reason: 'the guard doubled back' },
            { id: 'r2', capability: 'event.record', arguments: { summary: 'Aiden reached the courtyard' }, reason: 'it happened' },
        ],
        loreKeywords: [],
        loreOps: [],
        flow: { continue: false, hardPause: false },
    });
    const parsed = parseLoomReply(reply);
    expect(parsed.requests.map((r) => r.capability)).toEqual(['goal.edit', 'event.record']);
    expect(parsed.swaps).toEqual([{ find: 'the door', replace: 'the iron door' }]);
    expect(parsed.flow).toEqual({ continueAfter: false, hardPauseAfter: false });
});
