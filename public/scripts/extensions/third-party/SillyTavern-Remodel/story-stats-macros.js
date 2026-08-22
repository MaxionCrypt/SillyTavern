import { loadWorldInfo } from '../../../world-info.js';
import { MacroCategory, MacroValueType, macros } from '../../../macros/macro-system.js';
import { computeVariable, formatVariable, listVariableValues, variableHandle } from './variables-store.js';
import { entryKey } from './variables-lore-key.js';
import { getTimelineStore } from './timeline-state.js';

// Read-only prompt macros over V3 Variables.
//
// V3 retired owners and definitions, so the old two-part `owner::variable`
// address has no target: a Variable is now identified by its own name within a
// Timeline, and its meaning lives in the lorebook entries it links to. The
// address is therefore one part — a slug of the name, from the same
// `variableHandle` the Loom's address book uses, so what you type in a
// prompt and what the model is shown agree.
//
// Macro handlers are synchronous, so linked entry prose is served from a cache
// warmed in the background rather than read through the async lore layer.

let registered = false;
const loreCache = new Map();
const warnings = new Set();

export function registerStoryStatMacros() {
    if (registered) return;
    registered = true;
    for (const name of ['variable', 'stat']) {
        macros.register(name, {
            category: MacroCategory.CHARACTER,
            unnamedArgs: [
                { name: 'variable', type: MacroValueType.STRING, description: 'Variable name or handle, e.g. aiden.s.hp.' },
                { name: 'field', type: MacroValueType.STRING, optional: true, defaultValue: 'value', description: 'value, raw, minimum, maximum, state, modifiers, or a subvalue key.' },
            ],
            description: 'Reads a Remodel Variable without changing it.',
            returns: 'The current value or an empty string.',
            exampleUsage: [`{{${name}::aiden.s.hp}}`, `{{${name}::aiden.s.hp::maximum}}`],
            handler: ({ unnamedArgs: [variable, field] }) => readVariable(variable, field),
        });
    }
    for (const name of ['vardef', 'statdef']) {
        macros.register(name, {
            category: MacroCategory.CHARACTER,
            unnamedArgs: [
                { name: 'variable', type: MacroValueType.STRING, description: 'Variable name or handle, e.g. aiden.s.hp.' },
            ],
            description: 'Reads the lorebook prose a Variable is attached to.',
            returns: 'Linked entry prose, or the Variable description.',
            exampleUsage: [`{{${name}::aiden.s.hp}}`],
            handler: ({ unnamedArgs: [variable] }) => {
                const match = findVariable(variable);
                if (!match) return miss(`${name}: unresolved ${variable}`);
                const prose = match.loreLinks
                    .map((link) => loreCache.get(entryKey(link))?.content)
                    .filter(Boolean)
                    .join('\n\n');
                return prose || match.description || '';
            },
        });
    }
    refreshStatTypeCache().catch((error) => console.warn('Remodel Variables: lore cache warm-up failed', error));
}

/**
 * Warms the entry cache for every book a Variable links to.
 *
 * Reads through native `loadWorldInfo` rather than the Variables lore layer
 * because that layer is async and these macros are not; this keeps one book's
 * failure from taking the others with it.
 */
export async function refreshStatTypeCache() {
    const books = new Set(listVariableValues().flatMap((variable) => variable.loreLinks.map((link) => link.book)).filter(Boolean));
    for (const book of books) {
        try {
            // eslint-disable-next-line no-await-in-loop
            const data = await loadWorldInfo(book);
            for (const [uid, entry] of Object.entries(data?.entries || {})) {
                loreCache.set(entryKey({ book, uid }), { comment: String(entry?.comment || ''), content: String(entry?.content || '') });
            }
        } catch (error) {
            console.warn(`Remodel Variables: could not load lorebook "${book}"`, error);
        }
    }
}

/** Short label for a Variable: its first linked entry's memo, else its description. */
export function getStatTypeSummary(variable) {
    if (!variable) return '';
    const linked = (variable.loreLinks || []).map((link) => loreCache.get(entryKey(link))?.comment).find(Boolean);
    return linked || variable.description || '';
}

export function takeStatMacroWarnings() { const result = [...warnings]; warnings.clear(); return result; }

function readVariable(name, field) {
    const variable = findVariable(name);
    if (!variable) return miss(`variable: unresolved ${name}`);
    const computed = computeVariable(variable);
    switch (String(field || 'value').toLowerCase()) {
        // The stored value, before modifiers are applied.
        case 'raw': return String(variable.value);
        case 'minimum': case 'min': return computed.minimum == null ? '' : String(computed.minimum);
        case 'maximum': case 'max': return computed.maximum == null ? '' : String(computed.maximum);
        // V3 has no derived states; an enum Variable's state IS its value.
        case 'state': return variable.valueType === 'enum' ? String(variable.value ?? '') : '';
        case 'modifiers': case 'mods':
            return variable.modifiers.map((item) => `${item.label} ${Number(item.amount) >= 0 ? '+' : ''}${item.amount} ${item.target}`).join(', ');
        case '': case 'value': return formatVariable(variable);
        // Anything else addresses a subvalue by key, which is how V3 models the
        // fields the old store hard-coded.
        default: {
            const key = String(field).toLowerCase();
            const subvalue = variable.subvalues.find((item) => String(item.key).toLowerCase() === key);
            return subvalue ? String(subvalue.value ?? '') : miss(`variable: ${variable.name} has no field "${field}"`);
        }
    }
}

/**
 * Resolves a Variable within the active Timeline, by handle or by name.
 *
 * Scoped to the active Timeline deliberately: two Timelines may each hold a
 * Variable called "Vitality", and silently reading another story's value would
 * be worse than resolving to nothing.
 */
function findVariable(name) {
    const needle = String(name || '').trim().toLowerCase();
    if (!needle) return null;
    const timelineId = getTimelineStore().activeTimelineId || '';
    if (!timelineId) return null;
    const peers = listVariableValues({ timelineId });
    return peers.find((variable) => variableHandle(variable, null, peers).toLowerCase() === needle)
        || peers.find((variable) => String(variable.name).toLowerCase() === needle)
        || null;
}

function miss(message) { if (warnings.size < 50) warnings.add(message); return ''; }
