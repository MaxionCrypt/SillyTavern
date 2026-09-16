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
    // Sees the whole reply once it has parsed, for concerns the Archive port
    // refuses to carry. Living Lore is the one that matters: the port is
    // archive-only by design, so lore is filed BESIDE the Archive, not through
    // it, and this is the only way the reply reaches the thing that files it.
    observeReply = null,
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
        // Why this is read BEFORE the update: the update clears `error`, so by
        // the time the transport runs there is no record of what went wrong
        // last time. A transport that cannot tell a first attempt from a retry
        // after a reasoning-only reply can only send the identical request
        // again — which is exactly how three attempts burn on one bad turn.
        const previousError = next.error || null;
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
                    previousError,
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
                    : 'The Loom returned no Archive response.',
                { textChars: 0, reasoningChars: reasoning.length });
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
                throw retryableError('malformed-response', 'The Loom returned no readable Archive state fence.', {
                    textChars: raw.length,
                    hasFence: Boolean(result.receipt?.hasFence),
                    requestCount: Number(result.receipt?.requestCount || 0),
                });
            }
            if (typeof observeReply === 'function') {
                // After the fence is known to parse and before anything commits,
                // so an observer sees exactly the reply the Archive acts on. It
                // cannot fail the Archive: the prose is already canonical and a
                // lore side effect is not a reason to lose an event.record.
                try {
                    await observeReply({ job: running, jobId: running.jobId, raw });
                } catch { /* reported by the observer itself, never by the worker */ }
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

/**
 * `detail` carries the shape of the reply that failed — how much text, how
 * much reasoning, whether a fence was present. Without it every failure reads
 * as the same "Archive needs attention", and a model that returned nothing is
 * indistinguishable from one that reasoned past its budget or one that wrote
 * prose and forgot the fence. Those need three different fixes.
 */
function retryableError(code, message, detail = null) {
    const error = new Error(message);
    error.name = 'ArchiveWorkerError';
    error.code = code;
    if (detail) error.detail = detail;
    return error;
}

function serializeError(error) {
    return Object.freeze({
        code: String(error?.code || (isAbortError(error) ? 'aborted' : 'worker-error')),
        message: errorChain(error),
        ...(error?.detail ? { detail: Object.freeze({ ...error.detail }) } : {}),
    });
}

function errorChain(error) {
    const messages = [];
    const seen = new Set();
    let current = error;
    while (current && messages.length < 4 && !seen.has(current)) {
        seen.add(current);
        const message = String(current?.message || current || '').trim();
        if (message && !messages.includes(message)) messages.push(message);
        current = current?.cause;
    }
    return messages.join(' <- ') || 'Archive worker failed.';
}

function isAbortError(error) {
    return error?.name === 'AbortError';
}
