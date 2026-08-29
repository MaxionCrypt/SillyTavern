import {
    ARCHIVE_JOB_STATUS,
    describeArchiveWorkerStatus,
    isArchiveJobTerminal,
} from './archive-job-store.js';

export class ArchiveWorkerPermanentError extends Error {
    constructor(message, { code = 'permanently-rejected' } = {}) {
        super(message);
        this.name = 'ArchiveWorkerPermanentError';
        this.code = code;
        this.permanent = true;
    }
}

export function createArchiveWorker({
    repository,
    transport,
    ingestion,
    commit,
    now = () => Date.now(),
    maxAttempts = 3,
    retryDelayMs = 1_000,
    timeoutMs = 30_000,
} = {}) {
    if (!repository || typeof repository.enqueue !== 'function' || typeof repository.update !== 'function') {
        throw new TypeError('Archive worker requires a job repository.');
    }
    if (typeof transport !== 'function') throw new TypeError('Archive worker requires a transport port.');
    if (!ingestion || typeof ingestion.ingest !== 'function') throw new TypeError('Archive worker requires an ingestion port.');
    if (typeof commit !== 'function') throw new TypeError('Archive worker requires an Archive commit port.');

    const attemptLimit = Math.max(1, Math.floor(Number(maxAttempts) || 1));
    const retryDelay = Math.max(0, Math.floor(Number(retryDelayMs) || 0));
    const timeout = Math.max(1, Math.floor(Number(timeoutMs) || 1));
    const activeJobs = new Map();
    const timelineRuns = new Map();

    function enqueue(input) {
        const queued = repository.enqueue(input);
        for (const priorId of queued.provenance.supersedesJobIds) supersede(priorId, queued.jobId);
        return repository.get(queued.jobId);
    }

    function supersede(jobId, replacementJobId = '') {
        const current = repository.get(jobId);
        if (!current || isArchiveJobTerminal(current.status)) return current;
        activeJobs.get(current.jobId)?.abort('superseded');
        return repository.update(current.jobId, {
            status: ARCHIVE_JOB_STATUS.SUPERSEDED,
            supersededBy: String(replacementJobId || ''),
            nextAttemptAt: 0,
            error: null,
        });
    }

    function cancel(jobId, reason = 'cancelled') {
        const current = repository.get(jobId);
        if (!current || isArchiveJobTerminal(current.status)) return current;
        const cancelled = repository.update(current.jobId, {
            status: ARCHIVE_JOB_STATUS.CANCELLED,
            cancellationReason: String(reason || 'cancelled'),
            nextAttemptAt: 0,
            error: null,
        });
        activeJobs.get(current.jobId)?.abort(reason);
        return cancelled;
    }

    function retry(jobId) {
        const current = repository.get(jobId);
        if (!current) return null;
        if (current.status !== ARCHIVE_JOB_STATUS.FAILED_REPAIRABLE) return current;
        return repository.update(current.jobId, {
            status: ARCHIVE_JOB_STATUS.PENDING,
            attempts: 0,
            nextAttemptAt: 0,
            error: null,
            result: null,
        });
    }

    async function runNext(timelineId) {
        const id = String(timelineId || '');
        if (timelineRuns.has(id)) return timelineRuns.get(id);
        const run = runOne(id).finally(() => {
            if (timelineRuns.get(id) === run) timelineRuns.delete(id);
        });
        timelineRuns.set(id, run);
        return run;
    }

    async function runOne(timelineId) {
        const next = repository.next(timelineId);
        if (!next) return null;
        const running = repository.update(next.jobId, {
            status: ARCHIVE_JOB_STATUS.RUNNING,
            attempts: Number(next.attempts || 0) + 1,
            nextAttemptAt: 0,
            error: null,
        });
        const controller = new AbortController();
        activeJobs.set(running.jobId, controller);
        try {
            const response = await withTimeout(
                Promise.resolve().then(() => transport({
                    job: running,
                    jobId: running.jobId,
                    routeSnapshot: running.routeSnapshot,
                    promptSnapshot: running.promptSnapshot,
                    acceptedProse: running.acceptedProse,
                    statePacket: buildStatePacket(running),
                    signal: controller.signal,
                })),
                timeout,
                controller,
            );
            const afterTransport = repository.get(running.jobId);
            if ([ARCHIVE_JOB_STATUS.CANCELLED, ARCHIVE_JOB_STATUS.SUPERSEDED].includes(afterTransport?.status)) return afterTransport;
            const raw = responseText(response);
            if (!raw.trim()) {
                const reasoning = typeof response === 'object' ? String(response?.reasoning || '').trim() : '';
                throw retryableError(reasoning ? 'reasoning-only' : 'empty-response', reasoning
                    ? 'The Loom returned reasoning without an Archive response.'
                    : 'The Loom returned no Archive response.');
            }
            const result = await ingestion.ingest({
                mode: running.mode,
                jobId: running.jobId,
                timelineId: running.timelineId,
                sceneId: running.sceneId,
                acceptedProse: running.acceptedProse,
                statePacket: buildStatePacket(running),
                candidateReply: raw,
            });
            if (result.receipt?.fenceParsed === false) {
                throw retryableError('malformed-response', 'The Loom returned no readable Archive state fence.');
            }
            const beforeCommit = repository.get(running.jobId);
            if ([ARCHIVE_JOB_STATUS.CANCELLED, ARCHIVE_JOB_STATUS.SUPERSEDED].includes(beforeCommit?.status)) return beforeCommit;
            const commitReceipt = await commit({
                jobId: running.jobId,
                timelineId: running.timelineId,
                sceneId: running.sceneId,
                mode: running.mode,
                provenance: running.provenance,
                routeSnapshot: running.routeSnapshot,
                recipeId: running.promptSnapshot?.recipeId,
                acceptedProse: running.acceptedProse,
                operations: result.operations,
                lifecycleProposals: result.lifecycleProposals,
                archiveFacts: result.archiveFacts,
                ingestionReceipt: result.receipt,
            });
            const current = repository.get(running.jobId);
            if ([ARCHIVE_JOB_STATUS.CANCELLED, ARCHIVE_JOB_STATUS.SUPERSEDED].includes(current?.status)) return current;
            return repository.update(running.jobId, {
                status: ARCHIVE_JOB_STATUS.SUCCEEDED,
                nextAttemptAt: 0,
                error: null,
                result: {
                    operations: result.operations,
                    archiveFacts: result.archiveFacts,
                    ingestionReceipt: result.receipt,
                    commitReceipt: commitReceipt && typeof commitReceipt === 'object' ? commitReceipt : {},
                },
                completedAt: now(),
            });
        } catch (error) {
            const current = repository.get(running.jobId);
            if ([ARCHIVE_JOB_STATUS.CANCELLED, ARCHIVE_JOB_STATUS.SUPERSEDED].includes(current?.status)) return current;
            if (isAbortError(error) && controller.signal.aborted && controller.signal.reason !== 'archive-timeout') {
                return repository.update(running.jobId, {
                    status: ARCHIVE_JOB_STATUS.CANCELLED,
                    cancellationReason: String(controller.signal.reason || 'cancelled'),
                    error: null,
                });
            }
            const serialized = serializeError(error);
            if (error?.permanent === true || error instanceof ArchiveWorkerPermanentError) {
                return repository.update(running.jobId, {
                    status: ARCHIVE_JOB_STATUS.REJECTED,
                    nextAttemptAt: 0,
                    error: serialized,
                });
            }
            const attempts = Number(current?.attempts || running.attempts || 1);
            return repository.update(running.jobId, {
                status: attempts < attemptLimit ? ARCHIVE_JOB_STATUS.RETRYING : ARCHIVE_JOB_STATUS.FAILED_REPAIRABLE,
                nextAttemptAt: attempts < attemptLimit ? now() + retryDelay : 0,
                error: serialized,
            });
        } finally {
            if (activeJobs.get(running.jobId) === controller) activeJobs.delete(running.jobId);
        }
    }

    async function drain(timelineId) {
        const results = [];
        while (true) {
            const result = await runNext(timelineId);
            if (!result) break;
            results.push(result);
            if (result.status === ARCHIVE_JOB_STATUS.RETRYING && Number(result.nextAttemptAt || 0) > now()) break;
        }
        return results;
    }

    return Object.freeze({
        enqueue,
        runNext,
        drain,
        retry,
        cancel,
        supersede,
        recover: () => repository.recover(),
        get: (jobId) => repository.get(jobId),
        list: (timelineId) => repository.list(timelineId),
        status: (timelineId) => describeArchiveWorkerStatus(repository.list(timelineId)),
    });
}

function buildStatePacket(job) {
    return Object.freeze({
        sourceId: job.provenance.sourceId,
        documentId: job.provenance.documentId,
        messageId: job.provenance.messageId,
        checkpointId: job.provenance.checkpointId,
        interrupted: job.provenance.interrupted,
        reason: job.provenance.kind,
        archiveState: job.archiveContext,
        currentPlayerAction: job.currentPlayerAction,
    });
}

async function withTimeout(promise, timeoutMs, controller) {
    let timer;
    const timeout = new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
            controller.abort('archive-timeout');
            reject(retryableError('timeout', `Archive processing timed out after ${timeoutMs} ms.`));
        }, timeoutMs);
    });
    try {
        return await Promise.race([promise, timeout]);
    } finally {
        clearTimeout(timer);
    }
}

function responseText(response) {
    return typeof response === 'string' ? response : String(response?.text || '');
}

function retryableError(code, message) {
    const error = new Error(message);
    error.name = 'ArchiveWorkerError';
    error.code = code;
    return error;
}

function serializeError(error) {
    return Object.freeze({
        code: String(error?.code || (isAbortError(error) ? 'aborted' : 'worker-error')),
        message: String(error?.message || error || 'Archive worker failed.'),
    });
}

function isAbortError(error) {
    return error?.name === 'AbortError';
}
