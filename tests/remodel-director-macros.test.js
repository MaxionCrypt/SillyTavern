import {
    PROTOCOL_TEMPLATE,
    buildDirectorMacros,
    describeNotebookTags,
    describeStateFence,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/direction-sources.js';
import { ENTRY_TYPES } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/director-reply.js';
import { getCapabilityDictionary } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/mechanics-capabilities.js';

// The protocol's prose belongs to the owner. The parts the PARSER depends on
// expand from the code at compile time, so a recipe cannot carry a stale copy
// of a contract that has since changed — which is the failure this replaces.

test('the tags the macro renders are exactly the tags the parser matches', () => {
    // The one property that matters. Every other test here is downstream of it.
    const tags = describeNotebookTags();

    for (const type of ENTRY_TYPES) {
        expect(tags).toContain(`[${type}]`);
    }
    // And nothing the parser does NOT know, which would invite the Director to
    // write entries that silently become part of the note above them.
    const advertised = [...tags.matchAll(/^\[([a-z]+)\]/gm)].map((match) => match[1]);
    expect(advertised.sort()).toEqual([...ENTRY_TYPES].sort());
});

test('the seed carries macros, never a frozen copy of the machinery', () => {
    expect(PROTOCOL_TEMPLATE).toContain('{{director::notebook.tags}}');
    expect(PROTOCOL_TEMPLATE).toContain('{{director::state.fence}}');
    // A literal tag in the seed would be a copy that stops tracking the parser
    // the moment ENTRY_TYPES changes.
    for (const type of ENTRY_TYPES) {
        expect(PROTOCOL_TEMPLATE).not.toContain(`[${type}]`);
    }
});

test('the state fence macro renders the fence the reply parser looks for', () => {
    const fence = describeStateFence();

    expect(fence).toContain('```state');
    expect(fence).toContain('"capability"');
    expect(fence).toContain('"arguments"');
    expect(fence).toContain('"reason"');
});

test('the macro map answers every macro the seed uses', () => {
    const macros = buildDirectorMacros({ mechanics: { capabilities: getCapabilityDictionary() } }, { mechanicsEnabled: true });
    const used = [...PROTOCOL_TEMPLATE.matchAll(/{{director::(.+?)}}/g)].map((match) => match[1]);

    expect(used.length).toBeGreaterThan(0);
    for (const name of used) {
        expect(typeof macros[name]).toBe('string');
        expect(macros[name].length).toBeGreaterThan(0);
    }
});

test('capabilities expand from the live dictionary, so a new required argument reaches the prompt', () => {
    const macros = buildDirectorMacros({ mechanics: { capabilities: getCapabilityDictionary() } }, { mechanicsEnabled: true });

    expect(macros.capabilities).toContain('variable.create');
    expect(macros.capabilities).toContain('valueType');
});

test('the capabilities macro is empty when mechanics are off, rather than advertising refused writes', () => {
    const macros = buildDirectorMacros({ mechanics: { capabilities: getCapabilityDictionary() } }, { mechanicsEnabled: false });

    expect(macros.capabilities).toBe('');
});

test('an absent snapshot degrades to empty rather than throwing', () => {
    expect(() => buildDirectorMacros(null, {})).not.toThrow();
    expect(buildDirectorMacros(null, {})['notebook.tags']).toContain('[note]');
});
