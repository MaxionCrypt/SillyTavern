// Cutover controls and diagnostics for the modular pipeline.
//
// Eleven commits of isolate-rebuild-reconnect leave a pipeline where each stage
// may be running either the legacy implementation or its replacement. When
// something goes wrong the first question is always "which one was actually
// running?", and until now that answer had to be inferred from behaviour.
//
// Two jobs here: say plainly what is selected, and refuse the one switch that
// is never safe — changing who owns the prose while a turn is mid-flight.

export const PIPELINE_MODULES = Object.freeze([
    'turn-controller',
    'narrator-delivery',
    'archive-worker',
    'consequence-subscribers',
    'mechanics',
    'scene-council',
]);

export const IMPLEMENTATIONS = Object.freeze(['legacy', 'rebuilt']);

/** Modules that decide who writes the visible prose. Switching one of these
 * mid-turn would change authorship of a message already being written. */
const PROSE_OWNERSHIP_MODULES = Object.freeze(['turn-controller', 'narrator-delivery']);

export class CutoverRefused extends Error {}

/** The selected implementation per module. Absent means legacy: the running
 * implementation is the default until a Scene explicitly opts out of it. */
export function describeSelectedImplementations(selection = {}) {
    const rows = PIPELINE_MODULES.map((module) => Object.freeze({
        module,
        implementation: IMPLEMENTATIONS.includes(selection?.[module]) ? selection[module] : 'legacy',
        ownsProse: PROSE_OWNERSHIP_MODULES.includes(module),
    }));
    return Object.freeze(rows);
}

/**
 * Change one module's implementation. Refused while a turn is running IF that
 * module owns prose — a fallback that silently changed authorship halfway
 * through a message would produce a turn no one could later explain.
 */
export function selectImplementation(selection = {}, module, implementation, { turnActive = false } = {}) {
    if (!PIPELINE_MODULES.includes(module)) throw new CutoverRefused(`Unknown pipeline module ${module}.`);
    if (!IMPLEMENTATIONS.includes(implementation)) throw new CutoverRefused(`Unknown implementation ${implementation}.`);
    if (turnActive && PROSE_OWNERSHIP_MODULES.includes(module)) {
        throw new CutoverRefused(`${module} owns prose; it cannot be switched while a turn is running.`);
    }
    return Object.freeze({ ...selection, [module]: implementation });
}

/**
 * An immutable record of what a role actually sent to. Frozen at request time
 * so a later profile edit cannot rewrite the history of a turn that already ran
 * — the wrong-profile class of bug is only diagnosable if the receipt cannot
 * drift after the fact.
 */
export function recordRouteReceipt({ role, profileId, profileName = '', provider = '', model = '' } = {}) {
    if (!String(role || '').trim()) throw new CutoverRefused('A route receipt needs a role.');
    return Object.freeze({
        role: String(role),
        profileId: String(profileId || ''),
        profileName: String(profileName || ''),
        provider: String(provider || ''),
        model: String(model || ''),
        // A route without a bound model is the failure this receipt exists to
        // make visible, so it is recorded rather than rejected.
        complete: Boolean(String(profileId || '') && String(model || '')),
    });
}

/**
 * Per-turn timing waterfall. Stages are recorded in the order they occur with
 * their own elapsed span, so "the turn was slow" becomes "this stage was slow".
 */
export function createTurnWaterfall({ now = () => Date.now() } = {}) {
    const started = now();
    const stages = [];
    let last = started;
    let longTasks = 0;

    return Object.freeze({
        mark(stage) {
            const at = now();
            stages.push(Object.freeze({ stage: String(stage), at: at - started, elapsed: at - last }));
            last = at;
            return at - started;
        },
        /** Main-thread responsiveness: a stage that blocked long enough for the
         * user to notice is counted, not averaged away. */
        recordLongTask(durationMs, threshold = 50) {
            if (Number(durationMs) >= threshold) longTasks += 1;
            return longTasks;
        },
        finish() {
            const total = now() - started;
            const slowest = stages.reduce((worst, item) => (!worst || item.elapsed > worst.elapsed ? item : worst), null);
            return Object.freeze({
                total,
                stages: Object.freeze([...stages]),
                slowest,
                longTasks,
                responsive: longTasks === 0,
            });
        },
    });
}

/**
 * Why a queue job is where it is. `cause` and `repair` are the two things a
 * user actually needs: what went wrong, and what they can press.
 */
export function describeQueueJob(job = {}) {
    const status = String(job?.status || 'unknown');
    const attempts = Number(job?.attempts || 0);
    const cause = String(job?.error?.message || '');
    const repair = status === 'failed-repairable' ? 'retry'
        : status === 'failed' ? 'catch-up'
            : status === 'stale' ? 'supersede'
                : '';
    return Object.freeze({
        jobId: String(job?.jobId || job?.id || ''),
        status,
        attempts,
        cause,
        repair,
        needsAttention: Boolean(repair),
        // Exactly which accepted text this job ingested, so a wrong-source
        // ingestion is provable rather than suspected.
        acceptedSource: Object.freeze({
            contentHash: String(job?.promptSnapshot?.contentHash || ''),
            messageId: job?.messageId ?? null,
            characterBoundary: job?.acceptedBoundary ?? null,
        }),
    });
}
