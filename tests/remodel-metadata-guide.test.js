import { buildMetadataGuide } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/metadata-guide.js';
import {
    getCapabilityDictionary,
    getMechanicsRequestSchema,
    MECHANICS_PROTOCOL,
    REQUIRED_ARGUMENTS,
    validateMechanicsRequest,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/mechanics-capabilities.js';
import { readLoreKeywords, readLoreOps } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/loom-reconciliation.js';
import { buildProviderToolDefinitions, NARRATOR_MECHANIC_TOOLS } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/mechanics-gateway.js';

const argumentSchema = () => getMechanicsRequestSchema().schema.properties.requests.items.properties.arguments.properties;

describe('Remodel metadata guide', () => {
    // --- The examples are the point. They have to actually run. ------------

    test('every operation example passes the real request validator', () => {
        for (const capability of buildMetadataGuide().capabilities) {
            const request = JSON.parse(capability.example);
            const result = validateMechanicsRequest({ protocol: MECHANICS_PROTOCOL, requests: [request] });
            expect({ name: capability.name, errors: result.errors }).toEqual({ name: capability.name, errors: [] });
        }
    });

    test('every operation example supplies the arguments the engine demands', () => {
        for (const capability of buildMetadataGuide().capabilities) {
            const request = JSON.parse(capability.example);
            for (const [key] of REQUIRED_ARGUMENTS[capability.name] || []) {
                // The exact check validateArguments makes: present and non-empty.
                expect(`${capability.name}.${key}=${request.arguments[key]}`)
                    .toBe(`${capability.name}.${key}=${request.arguments[key]}`);
                expect(request.arguments[key] == null || request.arguments[key] === '').toBe(false);
            }
        }
    });

    test('every operation example names its own capability', () => {
        for (const capability of buildMetadataGuide().capabilities) {
            expect(JSON.parse(capability.example).capability).toBe(capability.name);
        }
    });

    // This is the defect the guide exists to prevent: an argument named without
    // its allowed values, where the code accepts a closed list and nothing else.
    test('every example value for a closed-list argument is in that list', () => {
        const properties = argumentSchema();
        for (const capability of buildMetadataGuide().capabilities) {
            const args = JSON.parse(capability.example).arguments;
            for (const [key, value] of Object.entries(args)) {
                const allowed = properties[key]?.enum;
                if (!allowed) continue;
                expect({ capability: capability.name, key, value }).toEqual({ capability: capability.name, key, value: expect.any(String) });
                expect(allowed).toContain(value);
            }
        }
    });

    test('closed-list arguments are printed with their values, not just a type', () => {
        const properties = argumentSchema();
        const printed = buildMetadataGuide().capabilities.flatMap((capability) => capability.arguments);
        for (const argument of printed) {
            const allowed = properties[argument.key]?.enum;
            if (!allowed) continue;
            expect(argument.values).toEqual([...allowed]);
        }
        // At least one really does exist, so this can never pass vacuously.
        expect(printed.some((argument) => argument.values.length)).toBe(true);
    });

    test('every printed argument is a real property of the request schema', () => {
        const properties = argumentSchema();
        for (const capability of buildMetadataGuide().capabilities) {
            for (const argument of capability.arguments) {
                expect({ capability: capability.name, key: argument.key, known: Boolean(properties[argument.key]) })
                    .toEqual({ capability: capability.name, key: argument.key, known: true });
            }
        }
    });

    test('required arguments are marked required, and match the validator table', () => {
        for (const capability of buildMetadataGuide().capabilities) {
            const marked = capability.arguments.filter((argument) => argument.required).map((argument) => argument.key);
            expect(marked).toEqual((REQUIRED_ARGUMENTS[capability.name] || []).map(([key]) => key));
        }
    });

    test('no argument is printed twice for one capability', () => {
        for (const capability of buildMetadataGuide().capabilities) {
            const keys = capability.arguments.map((argument) => argument.key);
            expect(keys).toEqual([...new Set(keys)]);
        }
    });

    test('every argument carries a hint', () => {
        for (const capability of buildMetadataGuide().capabilities) {
            for (const argument of capability.arguments) {
                expect(String(argument.hint || '').trim()).not.toBe('');
            }
        }
    });

    // --- Coverage against the live tables ----------------------------------

    test('advertises every capability the engine accepts, and no others', () => {
        expect(buildMetadataGuide().capabilities.map((item) => item.name))
            .toEqual(getCapabilityDictionary().map((item) => item.name));
    });

    test('surface sets match the live filters', () => {
        const byId = new Map(buildMetadataGuide().surfaces.map((surface) => [surface.id, surface]));
        expect(byId.get('roleplay-loom').accepts).toEqual(getCapabilityDictionary().map((item) => item.name));
    });

    // --- The fence and the envelope ----------------------------------------

    test('the fence example is a fence the parser accepts', () => {
        const { example, opener } = buildMetadataGuide().fence;
        expect(example.startsWith(opener)).toBe(true);
        const match = example.match(/```state\s*\n([\s\S]*?)\n?```/i);
        expect(match).not.toBeNull();
        const parsed = JSON.parse(match[1]);
        const live = new Set(getCapabilityDictionary().map((capability) => capability.name));
        for (const request of parsed.requests) expect(live.has(request.capability)).toBe(true);
    });

    test('every top-level key example is valid JSON in envelope position', () => {
        for (const item of buildMetadataGuide().envelope) {
            expect(() => JSON.parse(`{${item.example}}`)).not.toThrow();
            expect(Object.keys(JSON.parse(`{${item.example}}`))).toEqual([item.name]);
        }
    });

    // --- Living Lore --------------------------------------------------------

    test('the lore ops example survives the loreOps reader as edit and create', () => {
        const { loreOps } = JSON.parse(buildMetadataGuide().lore.ops.example);
        expect(readLoreOps(loreOps)).toEqual([
            { op: 'lore.edit', book: 'TL', uid: '1', content: 'The lighthouse has run unmanned on a timer since the keeper died.' },
            { op: 'lore.create', name: 'Queens Lake Lighthouse', keys: ['Queens Lake Lighthouse', 'the lighthouse'], secondaryKeys: [], content: 'A coastal light north of the town, automated.' },
        ]);
    });

    test('the keyword example survives the keyword reader unchanged', () => {
        const { loreKeywords } = JSON.parse(buildMetadataGuide().lore.keywords.example);
        expect(readLoreKeywords(loreKeywords)).toEqual(loreKeywords);
    });

    test('the stated keyword ceiling is the ceiling that is enforced', () => {
        const stated = Number(buildMetadataGuide().lore.keywords.arguments[0].hint.match(/Up to (\d+)/)[1]);
        expect(readLoreKeywords(Array.from({ length: stated + 3 }, (_, index) => [`key-${index}`]))).toHaveLength(stated);
    });

    // --- The Narrator side --------------------------------------------------

    test('lists the Narrator verbs that are actually offered', () => {
        expect(buildMetadataGuide().narrator.tools.map((tool) => tool.name)).toEqual([...NARRATOR_MECHANIC_TOOLS]);
    });

    test('every Narrator example supplies that verb’s required arguments', () => {
        const definitions = new Map(buildProviderToolDefinitions(NARRATOR_MECHANIC_TOOLS)
            .map((definition) => [definition.function.name, definition.function]));
        for (const tool of buildMetadataGuide().narrator.tools) {
            const args = JSON.parse(tool.example);
            for (const key of definitions.get(tool.name).parameters.required) {
                expect({ tool: tool.name, key, present: args[key] != null && args[key] !== '' })
                    .toEqual({ tool: tool.name, key, present: true });
            }
            // And nothing the schema does not declare.
            const known = new Set(Object.keys(definitions.get(tool.name).parameters.properties));
            for (const key of Object.keys(args)) expect(known.has(key)).toBe(true);
        }
    });

    test('Narrator arguments are printed from the definitions the provider is sent', () => {
        const definitions = new Map(buildProviderToolDefinitions(NARRATOR_MECHANIC_TOOLS)
            .map((definition) => [definition.function.name, definition.function]));
        for (const tool of buildMetadataGuide().narrator.tools) {
            const schema = definitions.get(tool.name).parameters;
            expect(tool.arguments.map((argument) => argument.key)).toEqual(Object.keys(schema.properties));
            expect(tool.arguments.filter((argument) => argument.required).map((argument) => argument.key))
                .toEqual([...schema.required]);
        }
    });
});
