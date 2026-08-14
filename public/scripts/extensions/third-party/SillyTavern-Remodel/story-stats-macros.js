import { loadWorldInfo } from '../../../world-info.js';
import { MacroCategory, MacroValueType, macros } from '../../../macros/macro-system.js';
import { computeVariable, formatVariable, getVariableDefinition, listVariableDefinitions, listVariableInstances } from './story-variables-store.js';

let registered = false;
const loreCache = new Map();
const warnings = new Set();

export function registerStoryStatMacros() {
    if (registered) return;
    registered = true;
    const valueHandler = ({ unnamedArgs: [owner, variable, field] }) => readVariable(owner, variable, field);
    for (const name of ['variable', 'stat']) {
        macros.register(name, {
            category: MacroCategory.CHARACTER,
            unnamedArgs: [
                { name: 'owner', type: MacroValueType.STRING, description: 'Stable owner ID or display label.' },
                { name: 'variable', type: MacroValueType.STRING, description: 'Variable definition key or name.' },
                { name: 'field', type: MacroValueType.STRING, optional: true, defaultValue: 'value', description: 'value, raw, maximum, state, modifiers, or reach.' },
            ],
            description: 'Reads a typed Remodel Variable without changing it.', returns: 'The current value or an empty string.',
            exampleUsage: [`{{${name}::character-avatar.png::hp}}`], handler: valueHandler,
        });
    }
    for (const name of ['vardef', 'statdef']) {
        macros.register(name, {
            category: MacroCategory.CHARACTER,
            unnamedArgs: [
                { name: 'owner', type: MacroValueType.STRING, description: 'Stable owner ID or display label.' },
                { name: 'variable', type: MacroValueType.STRING, description: 'Variable definition key or name.' },
            ],
            description: 'Reads the linked lorebook prose for a typed Variable definition.', returns: 'Definition prose or summary.',
            exampleUsage: [`{{${name}::character-avatar.png::hp}}`],
            handler: ({ unnamedArgs: [owner, variable] }) => {
                const match = findInstance(owner, variable);
                if (!match) return miss(`${name}: unresolved ${owner}/${variable}`);
                const definition = getVariableDefinition(match.definitionId, match.timelineId);
                return readLore(definition?.loreRef)?.content || definition?.summary || '';
            },
        });
    }
    refreshStatTypeCache().catch((error) => console.warn('Remodel Variables: lore cache warm-up failed', error));
}

export async function refreshStatTypeCache() {
    const books = new Set(listVariableDefinitions().map((definition) => definition.loreRef?.book).filter(Boolean));
    for (const book of books) {
        try {
            const data = await loadWorldInfo(book);
            for (const [uid, entry] of Object.entries(data?.entries || {})) loreCache.set(`${book}::${uid}`, { comment: String(entry?.comment || ''), content: String(entry?.content || '') });
        } catch (error) { console.warn(`Remodel Variables: could not load lorebook "${book}"`, error); }
    }
}

export function getStatTypeSummary(instance) {
    const definition = instance && getVariableDefinition(instance.definitionId, instance.timelineId);
    return readLore(definition?.loreRef)?.comment || definition?.summary || '';
}

export function takeStatMacroWarnings() { const result = [...warnings]; warnings.clear(); return result; }

function readVariable(owner, variable, field) {
    const instance = findInstance(owner, variable);
    if (!instance) return miss(`variable: unresolved ${owner}/${variable}`);
    const computed = computeVariable(instance);
    switch (String(field || 'value').toLowerCase()) {
        case 'raw': return String(instance.value);
        case 'maximum': case 'max': return computed.maximum == null ? '' : String(computed.maximum);
        case 'state': return computed.derivedState;
        case 'reach': return String(computed.reachModifier);
        case 'modifiers': case 'mods': return computed.modifiers.map((item) => `${item.label} ${item.delta >= 0 ? '+' : ''}${item.delta} ${item.target}`).join(', ');
        default: return formatVariable(instance);
    }
}

function findInstance(owner, variable) {
    const ownerNeedle = String(owner || '').toLowerCase();
    const variableNeedle = String(variable || '').toLowerCase();
    return listVariableInstances().find((instance) => {
        const definition = getVariableDefinition(instance.definitionId, instance.timelineId);
        return [instance.ownerRef.id, instance.ownerRef.label].some((value) => String(value).toLowerCase() === ownerNeedle)
            && [definition?.id, definition?.key, definition?.name].some((value) => String(value).toLowerCase() === variableNeedle);
    });
}

function readLore(ref) { return ref ? loreCache.get(`${ref.book}::${ref.uid}`) || null : null; }
function miss(message) { if (warnings.size < 50) warnings.add(message); return ''; }
