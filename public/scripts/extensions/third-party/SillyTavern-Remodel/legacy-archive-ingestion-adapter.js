import { describeLoomReply, parseLoomReply } from './loom-reconciliation.js';
import { isArchiveCapability, selectArchiveOperations } from './archive-ingestion.js';
import { isTimelineLifecycleCapability, selectTimelineLifecycleProposals } from './timeline-lifecycle-contract.js';

/** Existing Loom state-fence parser behind the new Archive-only port. */
export const legacyArchiveIngestionAdapter = Object.freeze({
    async ingest(request) {
        const parsed = parseLoomReply(request.candidateReply);
        const operations = selectArchiveOperations(parsed.requests);
        const lifecycleProposals = selectTimelineLifecycleProposals(parsed.requests);
        const rejected = (parsed.requests || [])
            .filter((candidate) => !isArchiveCapability(candidate?.capability) && !isTimelineLifecycleCapability(candidate?.capability))
            .map((candidate, index) => ({
                index,
                requestId: String(candidate?.id || ''),
                capability: String(candidate?.capability || ''),
                code: 'outside-archive-boundary',
            }));
        const reply = describeLoomReply(request.candidateReply);
        return {
            operations,
            lifecycleProposals,
            rejected,
            receipt: {
                hasFence: reply.hasFence,
                fenceParsed: reply.fenceParsed,
                requestCount: reply.requestCount,
                archiveOperationCount: operations.length,
                lifecycleProposalCount: lifecycleProposals.length,
            },
        };
    },
});

export function roleplayArchiveIngestionInput({ run, acceptedProse, candidateReply, archiveState = '', reason = '' } = {}) {
    return {
        mode: 'roleplay',
        jobId: String(run?.directionId || ''),
        timelineId: String(run?.timelineId || ''),
        sceneId: String(run?.sceneId || ''),
        acceptedProse,
        candidateReply,
        statePacket: {
            sourceId: String(run?.directionId || ''),
            messageId: run?.messageId,
            checkpointId: 'accepted',
            reason,
            interrupted: Boolean(run?.interrupted),
            archiveState,
            currentPlayerAction: String(run?.envelope?.currentPlayerAction || ''),
        },
    };
}

export function storyArchiveIngestionInput({ scene, docId, capture, acceptedProse, candidateReply, archiveState = '' } = {}) {
    return {
        mode: 'story',
        jobId: `story-archive:${String(capture?.id || '')}`,
        timelineId: String(scene?.timelineId || ''),
        sceneId: String(scene?.id || ''),
        acceptedProse,
        candidateReply,
        statePacket: {
            sourceId: String(capture?.generationId || capture?.id || ''),
            documentId: String(docId || ''),
            checkpointId: String(capture?.id || ''),
            interrupted: false,
            archiveState,
            currentPlayerAction: '',
        },
    };
}
