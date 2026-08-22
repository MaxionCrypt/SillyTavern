import { extension_prompt_roles, extension_prompt_types, main_api, setExtensionPrompt } from '../../../../script.js';
import { getCapabilityDictionary } from './mechanics-capabilities.js';
import { getSceneGoals, getSceneGoalRelations } from './story-goals-store.js';
import { getMechanicsProfile } from './variables-store.js';
import { resolveVariableContext } from './variables-context.js';
import { buildAddressBook } from './direction-address.js';

// Retired with the loom rework: `runMechanicalPreflight` (a second hidden
// model call that adjudicated mechanics before the Loom existed), and with
// it `mechanicalHandbook` and `formatMechanicalSnapshot`. All three had lost
// their last caller — the Loom's own requests replaced them — and
// `mechanicalHandbook` still taught the opposite of what the code now does:
// "addressing Variables by their temporary v1, v2... references and Goals by
// their temporary g1, g2... references". Names are the only address now
// (design section 3), so that text was the most misleading string in the
// extension. `profile.handbookAdditions` was its only input and is now unread;
// it is left in the store rather than migrated out, since nothing writes it.

const RECEIPT_PROMPT_KEY = 'remodel_mechanics_receipts';
let pendingReceipt = null;

export function canRunAutomaticMechanics() {
    return getMechanicsProfile().enabled && main_api === 'openai';
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

export async function previewMechanicalContext(scene, { cast = [], persona = null, action = '', evidence = {} } = {}) {
    // Retrieval (resolveVariableContext) scores against action/history/
    // activatedEntries, so a preview that wants the same Variables/Goals a
    // real pass would surface needs to hand those through rather than
    // substitute a placeholder and empty evidence — a caller with nothing
    // real to offer can still omit them and get the old inert behavior.
    //
    // `recordRecall: false` because a preview is the owner looking, not a turn
    // happening. Recall weights how often an item was retrieved on recent
    // TURNS; letting a preview write one would mean opening the drawer twice
    // reweighted the next real pass.
    return buildMechanicalSnapshot(
        scene,
        action || '[preview only: retrieve state; do not mutate or roll]',
        cast, persona, [], evidence, { recordRecall: false },
    );
}

export async function buildMechanicalSnapshot(scene, action, cast = [], persona = null, authorizedGoalIds = [], evidence = {}, { recordRecall = true } = {}) {
    const candidateGoals = getSceneGoals(scene.id, { includeResolved: false, states: ['active', 'background'] });
    const subjects = [persona, ...cast].filter(Boolean);
    const resolved = await resolveVariableContext({
        timelineId: scene.timelineId, action,
        history: evidence.history || [], cast: subjects,
        activatedEntries: evidence.activatedEntries || [], goals: candidateGoals,
        // A Goal the user is attempting this turn cannot be the one retrieval
        // drops: the prompt names it under ATTEMPTED THIS TURN and the
        // capability layer will accept a roll against it.
        pinnedGoalIds: authorizedGoalIds,
        correlationId: evidence.correlationId || null,
        recordRecall,
    });

    // Which Goals travel is retrieval's call now, not "every open Goal on the
    // Scene". Twenty Goals used to mean twenty Goals in the prompt on the
    // slowest call in the loop, every turn; they are ranked against Variables
    // under one shared budget instead.
    const goals = resolved.goals;

    // Goals get temporary refs for the same reason Variables do: a persistent
    // UUID in the prompt is one the model can echo back for a Goal that was
    // never advertised this pass. g1/g2 are meaningless outside this request.
    const goalRefs = new Map();
    const listedGoals = goals.map((goal, index) => {
        const ref = `g${index + 1}`;
        goalRefs.set(ref, goal.id);
        return {
            ref, title: goal.title, description: goal.description,
            holderRefs: goal.holderRefs, targetRefs: goal.targetRefs,
            successRate: goal.successRate, status: goal.status, visibility: goal.visibility,
        };
    });
    const refByGoalId = new Map([...goalRefs].map(([ref, id]) => [id, ref]));

    // The address book lets the Loom name a Variable or Goal directly —
    // see direction-address.js. Built only from what this pass actually
    // advertised: the Variables retrieval selected (resolved.listed), not
    // every Variable in the Timeline, and the Goals just listed above.
    const addressBook = buildAddressBook([
        ...resolved.listed.map((item) => ({ id: item.variable.id, name: item.variable.name })),
        ...goals.map((goal) => ({ id: goal.id, name: goal.title })),
    ]);

    return {
        timelineId: scene.timelineId, sceneId: scene.id, action: String(action),
        authorizedGoalRefs: authorizedGoalIds.map((id) => refByGoalId.get(String(id))).filter(Boolean),
        entities: subjects,
        goals: listedGoals,
        relationships: describeRelations(getSceneGoalRelations(scene.id), refByGoalId),
        // Variables travel as the compact lines serializeRetrievedVariables
        // produces — the format design section 3 specifies, and far cheaper
        // than a nested object each. Held here so callers need one object;
        // direction-sources.js renders them under its VARIABLES heading.
        serializedVariables: resolved.serialized,
        addressBook,
        // The operations a Loom may request, carried in the snapshot so
        // direction-sources.js can render them without importing
        // mechanics-capabilities.js itself — that module pulls in
        // variables-store.js/story-goals-store.js, which import st-context.js,
        // and direction-sources.js is required to stay free of that.
        capabilities: getCapabilityDictionary(),
        // Maps stringify as {}, so persistent IDs remain code-side only.
        variableRefs: resolved.refToId,
        goalRefs,
        // Only the shape of retrieval, never its rejects: naming the Variables
        // that deliberately did not surface would hand the model the context
        // retrieval just decided to withhold. Full diagnostics go to the journal.
        retrieval: {
            degraded: resolved.degraded, warning: resolved.vectorError, selected: resolved.listed.length,
            // Why the list is empty, not merely that it is. A Timeline holding no
            // Variables at all is an invitation to create one; a Timeline whose
            // Variables simply did not match this turn is not.
            emptyCode: resolved.listed.length ? '' : (resolved.emptyCode || 'none-matched'),
            goalsSelected: goals.length,
            goalsConsidered: candidateGoals.length,
            goalsEmptyCode: goals.length ? '' : (resolved.goalsEmptyCode || 'none-matched'),
        },
    };
}

/**
 * Relations between the Goals that actually travelled.
 *
 * Both ends must resolve to a ref. Retrieval can select one end of a relation
 * and drop the other, and a relation pointing at a Goal the Loom was never
 * shown is worse than no relation at all — it names something the model cannot
 * address and cannot be told anything more about.
 */
function describeRelations(relations, refByGoalId) {
    return (relations || []).map((relation) => ({
        ...relation,
        fromRef: refByGoalId.get(String(relation.fromGoalId ?? relation.goalId ?? '')) || '',
        toRef: refByGoalId.get(String(relation.toGoalId ?? relation.relatedGoalId ?? '')) || '',
        fromGoalId: undefined, toGoalId: undefined, goalId: undefined, relatedGoalId: undefined,
    })).filter((relation) => relation.fromRef && relation.toRef);
}

export function formatMechanicsReceipts(receipts) {
    if (!Array.isArray(receipts) || !receipts.length) return '';
    return `[Authoritative mechanical receipts. Do not reroll or contradict.]\n${receipts.map((receipt) => `- ${receipt.capability}: ${receipt.reason}.`).join('\n')}`;
}
