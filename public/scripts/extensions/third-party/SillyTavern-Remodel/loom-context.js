// Pure formatting for the Loom's mechanical context block.

/**
 * @param {object} snapshot the current mechanical snapshot
 * @param {{mechanicsEnabled: boolean}} options
 * @returns {{mechanicsSkill: string}}
 */
export function buildLoomContext(snapshot, { mechanicsEnabled = false } = {}) {
    return {
        mechanicsSkill: describeMechanics(snapshot?.mechanics, { mechanicsEnabled }),
    };
}

function describeMechanics(mechanics, { mechanicsEnabled = false } = {}) {
    const goals = Array.isArray(mechanics?.goals) ? mechanics.goals : [];
    // The one place refs are still read: relationships and the user's attached
    // attempts arrive keyed by `g1…gN` (buildMechanicalSnapshot), and both are
    // resolved back to titles here rather than being printed raw. Refless
    // Goals are excluded so an unresolved relationship endpoint — which
    // describeRelations renders as '' — cannot accidentally match one.
    const titleByRef = new Map(goals.filter((goal) => goal.ref && goal.title).map((goal) => [goal.ref, goal.title]));
    const sections = [
        mechanicsEnabled ? section('CAPABILITIES', describeCapabilities(mechanics?.capabilities)) : '',
        section('VARIABLES', mechanics?.serializedVariables || describeNoVariables(mechanics?.retrieval, mechanicsEnabled), describeRetrieval(mechanics?.retrieval)),
        section('GOALS', goals.map(describeGoal).join('\n') || describeNoGoals(mechanics?.retrieval, mechanicsEnabled)),
        mechanicsEnabled && goals.length ? section('RATING A GOAL', rateGuidance()) : '',
        section('RELATIONSHIPS', describeRelationships(mechanics?.relationships, titleByRef)),
        section('ATTEMPTED THIS TURN', describeAttempts(mechanics?.authorizedGoalRefs, titleByRef)),
    ].filter(Boolean);
    return [heading(mechanicsEnabled), ...sections, closing(mechanicsEnabled, mechanics)].filter(Boolean).join('\n\n');
}

function heading(mechanicsEnabled) {
    const title = '[GOALS AND VARIABLES — persistent memory, not a turn structure]';
    return mechanicsEnabled
        ? `${title}\nAddress each one by the exact name below. A name you were not given will be rejected. Never invent an identifier, never roll dice, never change state yourself — request it and code will validate and apply it.`
        : `${title}\nMechanical automation is unavailable this turn, so everything below is read-only: treat it as established fact your direction must respect, and return an empty requests array. Never roll dice or narrate a change to any value below.`;
}

function closing(mechanicsEnabled, mechanics) {
    if (!mechanicsEnabled) return '';
    const duplicates = mechanics?.addressBook?.duplicates || [];
    return duplicates.length
        ? `Unusable — these names are duplicated in this Timeline and cannot be addressed: ${duplicates.join(', ')}`
        : '';
}

/** A heading with nothing under it tells the Loom less than no heading. */
function section(title, body, note = '') {
    const content = String(body || '').trim();
    if (!content) return '';
    // The note is its own paragraph: run up against the last entry it reads as
    // part of that entry rather than as a caveat on the whole list.
    return [`${title}\n${content}`, note].filter(Boolean).join('\n\n');
}

/**
 * One Goal, with the fields the capability dictionary actually acts on.
 *
 * `successRate` above all: `goal.shift` exists to move exactly this number by
 * a named band, and the Loom was previously shown only title and status —
 * asked to shift a value it could not read.
 */
/**
 * What a Success Rate means, and roughly what a given chance is worth.
 *
 * These numbers used to be two lookup tables in story-goals-math.js —
 * seven named bands and four movement magnitudes — and `goal.shift` accepted
 * only the four words, with a schema line telling the model "never state a
 * percentage yourself". So the Loom could not express how far a Goal had
 * actually moved; it could only pick one of four sizes someone else chose.
 *
 * They are reference points now. The Loom reads them and states a number,
 * which is the whole difference between a rulebook and guidance.
 */
/**
 * What an empty VARIABLES list means, which is not one thing.
 *
 * It used to read "No relevant Variables were retrieved." in every case. On a
 * Timeline holding none at all that sentence is actively misleading — it says
 * some exist and none matched — and paired with the protocol's "if, and only
 * if, anything mechanical changed... otherwise leave it out entirely", a
 * Loom reading carefully concludes there is nothing to do and emits no
 * state block. Observed exactly that: a session of `tailFound: false` on a
 * Timeline with zero Variables and `variable.create` sitting unused sixth in a
 * list of twelve capabilities.
 *
 * The invitation appears only when mechanics are enabled. With them off the
 * Loom must return no requests at all, so inviting one would be a trap.
 */
function describeNoVariables(retrieval, mechanicsEnabled) {
    if (retrieval?.emptyCode !== 'none-authored') return 'None of this Timeline\'s Variables were relevant this turn.';
    if (!mechanicsEnabled) return 'This Timeline has no Variables yet.';
    return `This Timeline has no Variables yet — nothing here is being tracked as a number, a state, or a flag.
If something in this scene should be, create it with variable.create: how badly someone is hurt, how far a faction's patience has run, whether a door is barred, how close a pursuit has come. Give it a name you would recognise later and a one-line meaning written for your future self. It becomes addressable from the next turn onward.
Create one only when the fiction has actually raised it. An invented number nobody is playing with is noise you will be shown every turn afterwards.`;
}

/**
 * The same distinction the Variables block draws, for the same reason: a Scene
 * with no Goals at all is an invitation, and a Scene whose Goals simply did not
 * surface this turn is not. `(none active)` said the first thing while meaning
 * either, and a Loom shown it on an empty Scene had nothing telling it that
 * writing one down was even available.
 */
function describeNoGoals(retrieval, mechanicsEnabled) {
    if (retrieval?.goalsEmptyCode !== 'none-authored') return 'None of this Scene\'s Goals were relevant this turn.';
    if (!mechanicsEnabled) return 'No Goals are open in this Scene.';
    return `No Goals are open in this Scene — nothing here is being played toward an outcome that could fail.
When someone in the scene is actually reaching for something that could go either way, write it down with goal.create: what they are trying to do, and the chance it lands from the position the fiction has reached. A Goal is what the story is currently gambling on, not a task list.
Create one only when the fiction has raised the stakes itself. A Goal nobody is pushing on is noise you will be shown every turn afterwards.`;
}

function rateGuidance() {
    return `A Success Rate is the chance a decisive attempt lands from the position the fiction has reached. These are reference points, not a list to choose from — state the number that fits:
  5 nearly impossible · 15 extreme · 30 difficult · 50 uncertain · 70 favourable · 85 strongly favoured · 95 nearly assured
Rates hold between 5 and 95: a Goal already certain or already lost is a status, not a roll. When the fiction moves a Goal's position, say what its rate now is. For scale, a small shift is a few points, a real one is nearer seven, and a decisive turn is twenty or more.
Code rolls the d100 and settles the outcome. A reach returns a result you must respect — narrate the hit or the miss you were given, never the one you wanted.`;
}

function describeGoal(goal) {
    const facets = [goal.status, goal.visibility].filter(Boolean).join(', ');
    const rate = Number.isFinite(Number(goal.successRate)) ? ` — ${Number(goal.successRate)}%` : '';
    const detail = [
        goal.description,
        describeOwners('Held by', goal.holderRefs),
        describeOwners('Against', goal.targetRefs),
    ].filter(Boolean).map((line) => `  ${line}`);
    return [`- ${goal.title}${rate}${facets ? ` (${facets})` : ''}`, ...detail].join('\n');
}

function describeOwners(label, refs) {
    const names = (Array.isArray(refs) ? refs : []).map((ref) => ref?.label).filter(Boolean);
    return names.length ? `${label}: ${names.join(', ')}` : '';
}

function describeRelationships(relationships, titleByRef) {
    return (Array.isArray(relationships) ? relationships : []).map((relation) => {
        const from = titleByRef.get(relation.fromRef);
        const to = titleByRef.get(relation.toRef);
        if (!from || !to) return '';
        return `- ${from} → ${to} (${relation.type || 'related'})${relation.reason ? `: ${relation.reason}` : ''}`;
    }).filter(Boolean).join('\n');
}

/**
 * The Goal attempts the user attached to this action.
 *
 * `isAuthorizedGoal` still gates persona-held Goals on exactly these, and the
 * Roleplay preview still promises the user they "will be assessed by the
 * hidden Game Loom when sent" — so the Loom has to be told which ones.
 */
function describeAttempts(authorizedGoalRefs, titleByRef) {
    const titles = (Array.isArray(authorizedGoalRefs) ? authorizedGoalRefs : [])
        .map((ref) => titleByRef.get(ref)).filter(Boolean);
    if (!titles.length) return '';
    return [
        'The user attached these Goal attempts to the current action. Judge them in this direction.',
        ...titles.map((title) => `- ${title}`),
    ].join('\n');
}

/**
 * Retrieval that fell back is a caveat on the Variable list, not a section.
 *
 * Deliberately no `retrieval.warning`. That field holds a raw transport error
 * — observed reaching the Loom as "Failed to parse URL from
 * /api/vector/list" — which tells the model nothing it can act on and asks it
 * to parse machine text mid-prompt. What it needs is the consequence: this
 * list may be short. The error itself is already journalled by
 * variables-context.js (`retrieval.resolved`, `degradeCause`), which is where
 * it is useful, and it stays on the snapshot for the debug surfaces.
 */
function describeRetrieval(retrieval) {
    if (!retrieval?.degraded) return '';
    return 'Semantic retrieval was unavailable this turn, so this list was selected by direct reference alone and may be missing Variables that are relevant.';
}

/**
 * The verbs a Loom's `requests` may name, spelled out rather than left
 * for the model to infer from a record's shape. Without this list a Loom
 * can see a Variable or Goal in the snapshot above and have no idea what may
 * be asked of it — the dictionary existed for exactly this before the
 * compiled-recipe rework dropped it.
 *
 * Read from the snapshot rather than imported from mechanics-capabilities.js
 * directly: that module pulls in variables-store.js/story-goals-store.js,
 * which import st-context.js, and this module must not. mechanics-runtime.js
 * puts `getCapabilityDictionary()`'s output into `mechanics.capabilities` for
 * exactly this reason.
 */
/**
 * Each capability, and the arguments it cannot run without.
 *
 * The required arguments are the part that was missing, and their absence was
 * the whole defect: `validateArguments` refused every write the Loom
 * attempted — `valueType is required`, `holderRefs is required`, turn after
 * turn — while the words `valueType` and `holderRefs` appeared NOWHERE in the
 * prompt it was refusing. The Loom had one worked example in the protocol
 * block and guessed the rest, which is all it could do.
 *
 * The list comes from mechanics-capabilities.js's REQUIRED_ARGUMENTS, the same
 * table the validator reads, so the prompt and the refusal can no longer
 * disagree about what a capability needs.
 */
function describeCapabilities(capabilities) {
    return (Array.isArray(capabilities) ? capabilities : [])
        .map((capability) => {
            const head = `- ${capability.name} (${capability.applicableKinds.join(', ')}): ${capability.description}`;
            const required = Array.isArray(capability.requiredArguments) ? capability.requiredArguments : [];
            if (!required.length) return head;
            return `${head}
    arguments: ${required.map((argument) => `${argument.key} — ${argument.hint}`).join('; ')}`;
        })
        .join('\n');
}
