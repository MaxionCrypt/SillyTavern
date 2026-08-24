const STAGES = Object.freeze([
    ['context', 'Preparing context'],
    ['lore', 'Preparing lore'],
    ['narrator', 'Narrator drafting'],
    ['loom', 'Loom reconciling'],
    ['reveal', 'Revealing prose'],
    ['save', 'Saving turn'],
]);

const STAGE_INDEX = new Map(STAGES.map(([id], index) => [id, index]));
const STAGE_LABEL = new Map(STAGES);

export const DIRECTION_PROGRESS_STAGES = Object.freeze(STAGES.map(([id, label]) => Object.freeze({ id, label })));

export function createDirectionProgress(runId, at = Date.now()) {
    const startedAt = finiteTime(at);
    return {
        runId: String(runId || ''),
        status: 'running',
        startedAt,
        stage: 'context',
        stageStartedAt: startedAt,
        history: [],
    };
}

export function advanceDirectionProgress(progress, stage, at = Date.now()) {
    if (!progress || progress.status !== 'running' || !STAGE_INDEX.has(stage)) return progress;
    const currentIndex = STAGE_INDEX.get(progress.stage);
    const nextIndex = STAGE_INDEX.get(stage);
    if (nextIndex < currentIndex || stage === progress.stage) return progress;
    const changedAt = Math.max(progress.stageStartedAt, finiteTime(at));
    return {
        ...progress,
        stage,
        stageStartedAt: changedAt,
        history: [
            ...progress.history,
            { id: progress.stage, durationMs: changedAt - progress.stageStartedAt },
        ],
    };
}

export function settleDirectionProgress(progress, status = 'complete', at = Date.now()) {
    if (!progress || progress.status !== 'running') return progress;
    const settledAt = Math.max(progress.stageStartedAt, finiteTime(at));
    return {
        ...progress,
        status,
        settledAt,
        history: [
            ...progress.history,
            { id: progress.stage, durationMs: settledAt - progress.stageStartedAt },
        ],
    };
}

export function describeDirectionProgress(progress, at = Date.now()) {
    if (!progress) return null;
    const now = Math.max(progress.stageStartedAt, finiteTime(at));
    const elapsedMs = progress.status === 'running'
        ? now - progress.stageStartedAt
        : Math.max(0, Number(progress.settledAt) - progress.stageStartedAt);
    const totalMs = progress.status === 'running'
        ? now - progress.startedAt
        : Math.max(0, Number(progress.settledAt) - progress.startedAt);
    return {
        id: progress.stage,
        label: STAGE_LABEL.get(progress.stage) || progress.stage,
        status: progress.status,
        elapsedMs,
        totalMs,
        completed: progress.history.map((entry) => ({
            ...entry,
            label: STAGE_LABEL.get(entry.id) || entry.id,
        })),
    };
}

function finiteTime(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : Date.now();
}
