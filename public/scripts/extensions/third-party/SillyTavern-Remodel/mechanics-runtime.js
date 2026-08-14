import {
    extension_prompt_roles,
    extension_prompt_types,
    main_api,
    setExtensionPrompt,
} from '../../../../script.js';
import { getContext } from '../../../st-context.js';
import { executeMechanicsRequest, getCapabilityDictionary, getMechanicsRequestSchema, MECHANICS_PROTOCOL } from './mechanics-capabilities.js';
import { getSceneGoals, getSceneGoalRelations, nextStoryGoalTurn } from './story-goals-store.js';
import { computeVariable, formatVariable, getMechanicsProfile, listVariableDefinitions, listVariableInstances } from './story-variables-store.js';

const RECEIPT_PROMPT_KEY = 'remodel_mechanics_receipts';
let pendingReceipt = null;

export function canRunAutomaticMechanics() {
    return getMechanicsProfile().enabled && main_api === 'openai';
}

export async function runMechanicalPreflight({ scene, action, cast = [], persona = null, authorizedGoalIds = [] } = {}) {
    if (!scene?.timelineId || !String(action || '').trim()) return { skipped: true, reason: 'No mechanical action.' };
    const profile = getMechanicsProfile();
    if (!profile.enabled) return { skipped: true, reason: 'Mechanics are disabled for this account.' };
    if (main_api !== 'openai') throw new Error('Automatic mechanics require the current Chat Completion connection.');
    const turnId = nextStoryGoalTurn(scene.id, { timelineId: scene.timelineId });
    const snapshot = buildMechanicalSnapshot(scene, action, cast, persona, authorizedGoalIds);
    const prompt = [
        { role: 'system', content: mechanicalHandbook(profile.handbookAdditions) },
        { role: 'system', content: `CAPABILITY DICTIONARY\n${JSON.stringify(getCapabilityDictionary())}` },
        { role: 'user', content: `MECHANICAL SNAPSHOT\n${JSON.stringify(snapshot)}\n\nReturn one ${MECHANICS_PROTOCOL} envelope. Return an empty requests array when the action changes nothing worth tracking.` },
    ];
    const raw = await getContext().generateRaw({
        api: 'openai', prompt, responseLength: Math.max(256, Math.min(2048, Math.round(profile.contextBudget / 4))),
        instructOverride: false, jsonSchema: getMechanicsRequestSchema().schema,
    });
    let envelope;
    try { envelope = JSON.parse(raw); } catch { throw new Error('The Mechanical AI returned invalid structured JSON.'); }
    const result = executeMechanicsRequest(envelope, {
        timelineId: scene.timelineId, sceneId: scene.id, turnId,
        authorizedGoalIds,
        authorizedOwnerRefs: [],
        allowUserGoalCreate: false,
        allowVariableProposal: false,
    });
    if (!result.ok) throw new Error(result.errors?.join(' ') || 'The mechanical transaction was rejected.');
    return { ...result, turnId, snapshot };
}

export function prepareMechanicsReceiptInjection(scene, result) {
    const applied = (result?.receipts || []).filter((receipt) => receipt.status === 'applied');
    if (!applied.length) return false;
    const content = formatMechanicsReceipts(applied);
    pendingReceipt = { sceneId: scene.id, transactionId: result.transaction?.id || '', content };
    setExtensionPrompt(RECEIPT_PROMPT_KEY, content, extension_prompt_types.IN_CHAT, 0, false, extension_prompt_roles.SYSTEM, () => pendingReceipt?.sceneId === scene.id);
    return true;
}

export function clearMechanicsReceiptInjection() {
    pendingReceipt = null;
    setExtensionPrompt(RECEIPT_PROMPT_KEY, '', extension_prompt_types.IN_CHAT, 0);
}

export function previewMechanicalContext(scene, { cast = [], persona = null } = {}) {
    return buildMechanicalSnapshot(scene, '[preview: no action is assessed and no dice are rolled]', cast, persona);
}

export function buildMechanicalSnapshot(scene, action, cast, persona, authorizedGoalIds = []) {
    const goals = getSceneGoals(scene.id, { includeResolved: false, states: ['active', 'background'] });
    const ownerRefs = [persona, ...cast].filter(Boolean);
    const instances = listVariableInstances({ timelineId: scene.timelineId });
    const definitions = listVariableDefinitions({ includeTimeline: scene.timelineId });
    return {
        timelineId: scene.timelineId,
        sceneId: scene.id,
        action: String(action),
        explicitlyAuthorizedGoalIds: authorizedGoalIds.map(String),
        entities: ownerRefs,
        goals: goals.map((goal) => ({ id: goal.id, title: goal.title, description: goal.description, holderRefs: goal.holderRefs, targetRefs: goal.targetRefs, successRate: goal.successRate, resolution: goal.resolution, status: goal.status, visibility: goal.visibility })),
        relationships: getSceneGoalRelations(scene.id),
        variables: instances.map((instance) => ({ id: instance.id, definitionId: instance.definitionId, ownerRef: instance.ownerRef, value: formatVariable(instance), computed: computeVariable(instance) })),
        definitions: definitions.map((definition) => ({ id: definition.id, key: definition.key, name: definition.name, kind: definition.kind, summary: definition.summary, loreRef: definition.loreRef, constraints: definition.constraints, scaleBands: definition.scaleBands, enumStates: definition.enumStates, reachContribution: definition.reachContribution, impactScale: definition.impactScale, capabilities: definition.capabilities })),
    };
}

export function mechanicalHandbook(additions) {
    return `You are the hidden Mechanical AI for a roleplay system. You never narrate, roleplay, roll dice, invent IDs, or modify state directly. You can only submit advertised capability requests. Code owns all arithmetic, bounds, authorization, rolls, transitions, ordering, and persistence.

GOAL FORMATION
Create a Goal only for a meaningful unresolved outcome that is uncertain, actionable, persistent, and important enough to track. Identify typed holders and targets, avoid equivalents, choose one opening band, choose instant or tracked resolution, prefer an existing Variable, instantiate an existing definition if suitable, propose a timeline-local resource/number definition only when necessary, otherwise use instant resolution, then establish justified relationships. A new Goal may be reached in the same transaction only when this action is already decisive. Incidental Goals may be created and completed in one batch.

SUCCESS RATE
Opening bands are nearly_impossible 5, extreme 15, difficult 30, uncertain 50, favorable 70, strongly_favored 85, nearly_assured 95. Shift magnitudes are minor 3, meaningful 7, major 12, decisive 20. Every shift needs its own reason. Relationships inform judgment but never silently change rates. User reaches must be explicit; NPC reaches may be inferred. Choose and freeze one impactMagnitude before every tracked reach. Never request more than one reach for a Goal in a transaction.

VARIABLES
Lorebook prose describes fictional meaning; only the Capability Dictionary is executable. Several definitions may share one lorebook entry when they are mechanically distinct interpretations of the same concept. A definition never makes every owner equal: Resource values and maxima belong to individual instances. When instantiating a Resource, choose one advertised scaleBandId whose fictional scale fits that owner. Do not invent a maximum when bands are available. If none fit, propose a timeline-local definition for review instead of silently assuming 100. Enum and boolean Variables may transition or contribute configured modifiers, but cannot be tracked Constitution targets in this version. Never emit JavaScript or expressions.

AUTHORITY
User/persona-owned Goals and Variables require direct authorization or review. NPC, faction, object, location, group, timeline, and world changes may be automatic when bounded and justified.
${String(additions || '').trim()}`;
}

export function formatMechanicsReceipts(receipts) {
    if (!Array.isArray(receipts) || receipts.length === 0) return '';
    const lines = receipts.map((receipt) => {
        const roll = receipt.roll ? ` Roll ${receipt.roll.roll} against ${receipt.roll.rate}${receipt.roll.modifier ? ` with ${receipt.roll.modifier >= 0 ? '+' : ''}${receipt.roll.modifier}` : ''}: ${receipt.roll.hit ? 'hit' : `${receipt.roll.bandLabel} miss`}.` : '';
        return `- ${receipt.capability}: ${receipt.reason}.${roll}`;
    });
    return `[Authoritative mechanical receipts. Treat these outcomes as already resolved. Do not reroll, contradict, or expose secret state.]\n${lines.join('\n')}`;
}
