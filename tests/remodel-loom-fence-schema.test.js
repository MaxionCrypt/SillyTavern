import { __setExtensionSettings } from './util/st-context-stub.js';
import { getRoleplayLoomGoalSchema, toCoreJsonSchema } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/loom-fence-schema.js';
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

/** The loreOps branches, keyed by their op enum ("lore.edit" / "lore.create"). */
const opBranches = () => {
    const map = new Map();
    for (const branch of getRoleplayLoomGoalSchema().schema.properties.loreOps.items.anyOf) {
        map.set(branch.properties.op.enum[0], branch);
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

test('the top-level fence carries exactly the four state-fence keys', () => {
    const schema = getRoleplayLoomGoalSchema().schema;
    expect(new Set(Object.keys(schema.properties)))
        .toEqual(new Set(['swaps', 'loreKeywords', 'loreOps', 'flow']));
    // Goals/Variables are dissolved: no mechanics `requests` array survives.
    expect(schema.properties.requests).toBeUndefined();
    expect(schema.required).not.toContain('requests');
});

test('loreOps declares strict edit and create branches', () => {
    const schema = getRoleplayLoomGoalSchema().schema;
    expect(schema.required).toContain('loreOps');
    const ops = [...opBranches().keys()].sort();
    expect(ops).toEqual(['lore.create', 'lore.edit']);
    // The boundary that matters: nothing goal/variable/scene leaked back in.
    for (const op of ops) {
        expect(op.startsWith('goal.')).toBe(false);
        expect(op.startsWith('variable.')).toBe(false);
        expect(op.startsWith('scene.')).toBe(false);
        expect(op.startsWith('event.')).toBe(false);
    }
});

test('lore.edit lists every arg in `required`, with secret present-but-nullable', () => {
    const edit = opBranches().get('lore.edit').properties.arguments;
    // Strict mode lists every property in `required`; the optional `secret` is
    // present-but-nullable so a visibility change can be omitted as null.
    expect(edit.required).toEqual(['book', 'uid', 'content', 'secret']);
    expect(edit.properties.secret.type).toEqual(['boolean', 'null']);
});

test('lore.create hard-requires name/keys/content and keeps secret+secondaryKeys nullable', () => {
    const create = opBranches().get('lore.create').properties.arguments;
    expect(create.required).toEqual(expect.arrayContaining(['name', 'keys', 'content']));
    // Optionals are nullable so "not applicable" is expressible under strict mode.
    expect(create.properties.secret.type).toEqual(['boolean', 'null']);
    expect(create.properties.secondaryKeys.type).toContain('null');
    // The required content key must NOT be nullable.
    const contentType = create.properties.content.type;
    expect(Array.isArray(contentType) ? contentType : [contentType]).not.toContain('null');
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
        loreKeywords: [],
        loreOps: [
            { id: 'o1', op: 'lore.edit', arguments: { book: 'TL', uid: '1', content: 'The door is iron.' }, reason: 'the accepted prose changed this fact' },
        ],
        flow: { continue: false, hardPause: false },
    });
    const parsed = parseLoomReply(reply);
    expect(parsed.loreOps.map((o) => o.op)).toEqual(['lore.edit']);
    expect(parsed.swaps).toEqual([{ find: 'the door', replace: 'the iron door' }]);
    expect(parsed.flow).toEqual({ continueAfter: false, hardPauseAfter: false });
    // The dissolved `requests` channel is gone from the parse result.
    expect(parsed.requests).toBeUndefined();
});
