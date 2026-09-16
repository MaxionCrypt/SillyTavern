import { buildMetadataGuide } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/metadata-guide.js';
import { ARCHIVE_CAPABILITY_NAMES } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/archive-ingestion.js';
import { TIMELINE_LIFECYCLE_CAPABILITIES } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/timeline-lifecycle-contract.js';
import { legacyArchiveIngestionAdapter } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/legacy-archive-ingestion-adapter.js';
import {
    getCapabilityDictionary,
    getMechanicsRequestSchema,
    MECHANICS_PROTOCOL,
    REQUIRED_ARGUMENTS,
    validateMechanicsRequest,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/mechanics-capabilities.js';
import { MAX_INFORMATION_CHARS, readLoomInformation } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/living-lore-intake.js';
import { readLoreKeywords } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/loom-reconciliation.js';
import { parsePromotionDecisions } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/world-sense-promotion.js';
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
        expect(byId.get('background-archive').accepts).toEqual([...ARCHIVE_CAPABILITY_NAMES, ...TIMELINE_LIFECYCLE_CAPABILITIES]);
        expect(byId.get('roleplay-loom').accepts).toEqual(getCapabilityDictionary().map((item) => item.name));
    });

    // The guide once derived Story from the test adapter's wider set and printed
    // capabilities production drops. So: run every capability through the REAL
    // background ingestion and require the guide to agree with what survives.
    test('the background surface is exactly what the production ingestion keeps', async () => {
        const surface = buildMetadataGuide().surfaces.find((item) => item.id === 'background-archive');
        const requests = getCapabilityDictionary().map((capability, index) => ({
            id: `r${index}`, capability: capability.name, arguments: {}, reason: 'probe',
        }));
        const reply = '```state\n' + JSON.stringify({ requests }) + '\n```';
        const result = await legacyArchiveIngestionAdapter.ingest({ candidateReply: reply });
        const kept = [...result.operations, ...result.lifecycleProposals].map((request) => request.capability).sort();
        expect([...surface.accepts].sort()).toEqual(kept);
        for (const rejected of result.rejected) {
            expect(surface.accepts).not.toContain(rejected.capability);
            expect(surface.note).toContain(rejected.capability);
        }
    });

    test('names goal.reach as refused on the background surface, derived not typed', () => {
        const surface = buildMetadataGuide().surfaces.find((item) => item.id === 'background-archive');
        expect(surface.accepts).not.toContain('goal.reach');
        expect(surface.note).toContain('goal.reach');
        expect(surface.note).toContain('successRate');
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

    test('the lore report example is a report intake accepts', () => {
        const { accepted, rejected } = readLoomInformation([JSON.parse(buildMetadataGuide().lore.proposal.example)]);
        expect(rejected).toEqual([]);
        expect(accepted).toHaveLength(1);
    });

    test('the stated content limit is the limit that is enforced', () => {
        const stated = Number(buildMetadataGuide().lore.proposal.arguments
            .find((argument) => argument.key === 'content').hint.match(/Over (\d+) characters/)[1]);
        expect(stated).toBe(MAX_INFORMATION_CHARS);
        expect(readLoomInformation([{ content: 'a'.repeat(stated), evidence: ['x'] }]).accepted).toHaveLength(1);
        expect(readLoomInformation([{ content: 'a'.repeat(stated + 1), evidence: ['x'] }]).rejected[0].code).toBe('content-too-long');
    });

    test('the keyword example survives the keyword reader unchanged', () => {
        const { loreKeywords } = JSON.parse(buildMetadataGuide().lore.keywords.example);
        expect(readLoreKeywords(loreKeywords)).toEqual(loreKeywords);
    });

    test('the stated keyword ceiling is the ceiling that is enforced', () => {
        const stated = Number(buildMetadataGuide().lore.keywords.arguments[0].hint.match(/Up to (\d+)/)[1]);
        expect(readLoreKeywords(Array.from({ length: stated + 3 }, (_, index) => `key-${index}`))).toHaveLength(stated);
    });

    test('the promotion example is a decision the parser accepts', () => {
        const decision = JSON.parse(buildMetadataGuide().lore.promotion.example);
        const packet = { candidates: [{ id: decision.candidateId }] };
        expect(parsePromotionDecisions([decision], packet).rejected).toEqual([]);
        expect(parsePromotionDecisions(
            [{ ...decision, decision: 'maybe' }], packet,
        ).rejected[0].code).toBe('invalid-decision');
    });

    test('the promotion decision words are the words the parser allows', () => {
        const words = buildMetadataGuide().lore.promotion.arguments
            .find((argument) => argument.key === 'decision').values;
        expect(words.length).toBeGreaterThan(1);
        const packet = { candidates: words.map((word, index) => ({ id: `c${index}` })) };
        const decisions = words.map((word, index) => ({ candidateId: `c${index}`, decision: word, reason: 'because' }));
        expect(parsePromotionDecisions(decisions, packet).rejected).toEqual([]);
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
