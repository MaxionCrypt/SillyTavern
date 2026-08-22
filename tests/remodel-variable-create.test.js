import {
    MECHANICS_PROTOCOL,
    executeMechanicsRequest,
    getCapabilityDictionary,
    getMechanicsRequestSchema,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/mechanics-capabilities.js';
import { listVariableValues } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/variables-store.js';
import { resolveVariableContext } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/variables-context.js';
import { buildAddressBook, resolveByName } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/direction-address.js';
import { __setExtensionSettings } from './util/st-context-stub.js';

// variable.create, end to end through the real capability layer and the real
// store. The owner's log showed `retrieval.skipped :: "This Timeline has no
// Variables."` on every single pass: with nothing authored there was nothing to
// advertise, and no verb that could ever change that.
//
// There is no vector backend under Node, so retrieval degrades to its
// deterministic path — which is exactly the condition that makes the retrieval
// mode chosen at creation load-bearing, and why the reachability tests below
// are meaningful rather than incidental.

const TIMELINE = 'timeline-create-1';
const SCENE = 'scene-create-1';

beforeEach(() => {
    __setExtensionSettings({ remodel: {} });
});

/**
 * One transaction, addressed exactly the way production addresses one: the
 * table is built BEFORE the batch runs (live-direction.js's
 * executeDirectionRequests calls addressRequestsByName once, up front), so
 * nothing a request creates can appear in it.
 */
function run(requests, variableRefs = new Map()) {
    return executeMechanicsRequest(
        { protocol: MECHANICS_PROTOCOL, requests },
        { timelineId: TIMELINE, sceneId: SCENE, variableRefs, goalRefs: new Map() },
    );
}

function createRequest(overrides = {}, id = 'r1') {
    return {
        id, capability: 'variable.create',
        arguments: {
            name: "Aiden's Corruption", valueType: 'number', value: 0,
            description: 'How far the rite has taken him.',
            minimum: 0, maximum: 10,
            ...overrides,
        },
        reason: 'The rite left its mark on him.',
    };
}

function variableNamed(name) {
    return listVariableValues({ timelineId: TIMELINE }).find((item) => item.name === name) || null;
}

/** What a later turn would advertise, built the way mechanics-runtime.js does. */
async function advertise() {
    const resolved = await resolveVariableContext({
        timelineId: TIMELINE, action: 'Aiden steadies himself in the dark.',
    });
    return {
        resolved,
        book: buildAddressBook(resolved.listed.map((item) => ({ id: item.variable.id, name: item.variable.name }))),
    };
}

describe('creating a usable Variable', () => {
    test('applies through the normal receipt path and stores every field it was given', () => {
        const result = run([createRequest()]);

        expect(result.ok).toBe(true);
        expect(result.transaction.status).toBe('applied');
        const receipt = result.receipts.find((item) => item.capability === 'variable.create');
        expect(receipt.status).toBe('applied');
        expect(receipt.before).toBeNull();
        expect(receipt.reason).toBe('The rite left its mark on him.');

        const created = variableNamed("Aiden's Corruption");
        expect(created).not.toBeNull();
        expect(created.valueType).toBe('number');
        expect(created.value).toBe(0);
        expect(created.description).toBe('How far the rite has taken him.');
        expect(created.subvalues.find((item) => item.role === 'minimum').value).toBe(0);
        expect(created.subvalues.find((item) => item.role === 'maximum').value).toBe(10);
    });

    test('creates an enum Variable with the states variable.transition will later need', () => {
        const result = run([createRequest({
            name: 'Watch Alertness', valueType: 'enum', value: 'suspicious',
            enumValues: ['unaware', 'suspicious', 'hunting'],
            minimum: undefined, maximum: undefined,
        })]);

        expect(result.ok).toBe(true);
        const created = variableNamed('Watch Alertness');
        expect(created.valueType).toBe('enum');
        expect(created.enumValues).toEqual(['unaware', 'suspicious', 'hunting']);
        expect(created.value).toBe('suspicious');
    });
});

describe('reachability — a created Variable must not be write-only', () => {
    test('is retrieved again on a later pass, with no lore entry to hang off', async () => {
        expect(run([createRequest()]).ok).toBe(true);
        const created = variableNamed("Aiden's Corruption");
        // The condition that makes this hard: it is attached to nothing, so no
        // lore link and no semantic evidence can ever corroborate it.
        expect(created.loreLinks).toEqual([]);
        expect(created.retrieval.mode).toBe('always');

        const { resolved } = await advertise();

        expect(resolved.listed.map((item) => item.variable.name)).toContain("Aiden's Corruption");
        expect(resolved.serialized).toContain('How far the rite has taken him.');
    });

    test('becomes addressable by name on a later turn, through the ordinary address book', async () => {
        expect(run([createRequest()]).ok).toBe(true);
        const created = variableNamed("Aiden's Corruption");

        const { book } = await advertise();

        expect(resolveByName(book, "Aiden's Corruption")).toEqual({ ok: true, id: created.id });
    });
});

describe('containment — not addressable on the turn it was created', () => {
    test('a later request in the same batch cannot name it, and the whole batch rolls back', () => {
        const result = run([
            createRequest({ name: 'Ward Integrity' }),
            {
                id: 'r2', capability: 'variable.adjust',
                arguments: { variableRef: 'Ward Integrity', delta: -3 },
                reason: 'The ward took the blow.',
            },
        ]);

        expect(result.ok).toBe(false);
        expect(result.transaction.status).toBe('rolled-back');
        expect(result.errors[0]).toMatch(/was not advertised for this request/i);
        // Rolled back means rolled back: the creation does not survive the
        // failure of the request that leaned on it.
        expect(variableNamed('Ward Integrity')).toBeNull();
    });

    test('the address table a turn was given is never widened by a creation in it', () => {
        const refs = new Map();
        expect(run([createRequest({ name: 'Ward Integrity' })], refs).ok).toBe(true);

        expect(refs.size).toBe(0);
        expect(refs.get('Ward Integrity')).toBeUndefined();
    });
});

describe('name uniqueness', () => {
    test('refuses a name the Timeline already holds, ignoring case and surrounding space', () => {
        expect(run([createRequest({ name: 'Morale', minimum: 0, maximum: 100, value: 50 })]).ok).toBe(true);

        const result = run([createRequest({ name: '  morale ', minimum: 0, maximum: 100, value: 10 })], new Map());

        expect(result.ok).toBe(false);
        expect(result.errors[0]).toMatch(/already has a Variable named/i);
        expect(listVariableValues({ timelineId: TIMELINE })).toHaveLength(1);
        expect(variableNamed('Morale').value).toBe(50);
    });

    test('refuses a name an earlier request in the same batch just created', () => {
        const result = run([
            createRequest({ name: 'Morale', value: 5 }, 'r1'),
            createRequest({ name: 'MORALE', value: 9 }, 'r2'),
        ]);

        expect(result.ok).toBe(false);
        expect(result.errors[0]).toMatch(/already has a Variable named/i);
        expect(listVariableValues({ timelineId: TIMELINE })).toHaveLength(0);
    });

    test('a duplicate would have made BOTH records unaddressable, which is why it is refused', async () => {
        expect(run([createRequest({ name: 'Morale', value: 5 })]).ok).toBe(true);
        expect(run([createRequest({ name: 'morale', value: 9 })], new Map()).ok).toBe(false);

        const { book } = await advertise();

        // The property the refusal protects: had both survived, buildAddressBook
        // would refuse the name and neither could ever be addressed again.
        expect(resolveByName(book, 'Morale').ok).toBe(true);
        expect(book.duplicates).toEqual([]);
    });
});

describe('authority', () => {
    test('a created Variable carries review authority, not world', () => {
        expect(run([createRequest()]).ok).toBe(true);

        expect(variableNamed("Aiden's Corruption").authority).toBe('review');
    });

    test('a later Loom write to the invented fact defers for review instead of applying', async () => {
        expect(run([createRequest()]).ok).toBe(true);
        const created = variableNamed("Aiden's Corruption");
        const { book } = await advertise();
        const refs = new Map([["Aiden's Corruption", resolveByName(book, "Aiden's Corruption").id]]);

        const result = run([{
            id: 'r1', capability: 'variable.adjust',
            arguments: { variableRef: "Aiden's Corruption", delta: 3 },
            reason: 'The rot spread overnight.',
        }], refs);

        // Deferred, not refused: the name resolved (so it IS addressable), and
        // the write was held rather than applied to a fact the model invented.
        expect(result.transaction.status).toBe('pending');
        const receipt = result.receipts[0];
        expect(receipt.status).toBe('pending');
        expect(receipt.approvalStatus).toBe('required');
        expect(receipt.rejectionReason).toMatch(/requires review/i);
        expect(variableNamed("Aiden's Corruption").value).toBe(created.value);
    });
});

describe('malformed requests are refused with a diagnostic, never partly applied', () => {
    const cases = [
        ['a missing name', { name: '' }, /name is required/i],
        ['a missing meaning', { description: '' }, /description is required/i],
        ['a missing starting value', { value: null }, /value is required/i],
        ['an unknown kind', { valueType: 'resource' }, /valueType must be one of/i],
        ['a missing kind', { valueType: '' }, /valueType is required/i],
        ['an enum with one state', { valueType: 'enum', value: 'calm', enumValues: ['calm'], minimum: undefined, maximum: undefined }, /at least two distinct states/i],
        ['an enum whose value is not one of its states', { valueType: 'enum', value: 'furious', enumValues: ['calm', 'wary'], minimum: undefined, maximum: undefined }, /must be one of the states/i],
        ['states on a non-enum kind', { enumValues: ['calm', 'wary'] }, /only applies to an enum/i],
        ['bounds on a non-number kind', { valueType: 'text', value: 'a rumour', minimum: 0 }, /only a number Variable/i],
        ['a value below its own floor', { value: -4 }, /falls outside the bounds/i],
        ['a value above its own ceiling', { value: 40 }, /falls outside the bounds/i],
        ['an inverted range', { minimum: 10, maximum: 0, value: 5 }, /is above maximum/i],
        ['a non-numeric value for a number', { value: 'quite a lot' }, /must be a finite number/i],
    ];

    test.each(cases)('refuses %s', (_label, overrides, pattern) => {
        const result = run([createRequest(overrides)]);

        expect(result.ok).toBe(false);
        expect(result.errors[0]).toMatch(pattern);
        expect(listVariableValues({ timelineId: TIMELINE })).toHaveLength(0);
    });

    test('a malformed create does not take an earlier valid one down with it silently', () => {
        const result = run([
            createRequest({ name: 'Keep Repair', value: 2 }, 'r1'),
            createRequest({ name: 'Larder', value: 99 }, 'r2'),
        ]);

        // r2's value is above its own maximum of 10, so the transaction fails —
        // and r1's creation is rolled back with it rather than left half-applied.
        expect(result.ok).toBe(false);
        expect(result.errors[0]).toMatch(/r2: value 99 falls outside/i);
        expect(listVariableValues({ timelineId: TIMELINE })).toHaveLength(0);
    });

    test('an absent bound is absent, not a floor of zero', () => {
        expect(run([createRequest({ name: 'Debt', value: -20, minimum: undefined, maximum: undefined })]).ok).toBe(true);

        // Number(null) is 0 and passes Number.isFinite; a presence test by
        // coercion would have clamped this to 0 and reported success.
        expect(variableNamed('Debt').value).toBe(-20);
        expect(variableNamed('Debt').subvalues).toEqual([]);
    });
});

describe('the Loom is told the capability exists', () => {
    test('the dictionary rendered into the prompt carries variable.create', () => {
        const entry = getCapabilityDictionary().find((item) => item.name === 'variable.create');

        expect(entry).toBeDefined();
        expect(entry.description).toMatch(/does not have yet/i);
        expect(entry.applicableKinds).toEqual(['number', 'enum', 'text', 'boolean']);
    });

    test('the request schema accepts it and describes the arguments it needs', () => {
        const schema = getMechanicsRequestSchema();
        const request = schema.schema.properties.requests.items;

        expect(request.properties.capability.enum).toContain('variable.create');
        for (const field of ['name', 'valueType', 'enumValues', 'minimum', 'maximum']) {
            expect(request.properties.arguments.properties[field]).toBeDefined();
        }
        expect(request.properties.arguments.properties.valueType.enum).toEqual(['number', 'enum', 'text', 'boolean']);
    });
});
