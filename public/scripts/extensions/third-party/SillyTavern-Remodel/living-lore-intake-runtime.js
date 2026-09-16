// The intake path, end to end.
//
// One entrance for both Roleplay and Story, because the Loom reports the same
// way in each and the placement rules do not care which surface the fiction
// came from.
//
//   read what the Loom reported
//     → score it against the book (semantic, recursive, temporal)
//       → append into an existing entry, or create a new one
//
// Deliberately not routed through queueLivingLoreProposals. That path is
// typed-operation shaped, target-driven and review-gated, and it is retired.
// Nothing here revives it.
//
// The book is reloaded between records. Placing the second report against a
// snapshot taken before the first one was written would score it against lore
// that is already out of date, and two reports about the same subject in one
// turn is exactly when that matters.

import { evidenceSource } from './living-lore-mutations.js';
import { listLivingLoreMetadata } from './living-lore-store.js';
import { placeLivingLoreInformation, readLoomInformation } from './living-lore-intake.js';
import { applyLivingLoreIntake } from './living-lore-writer.js';
import { queryWorldSense } from './world-sense-embeddings.js';
import { invalidateTimelineLoreCache, loadTimelineLore } from './world-sense-lore.js';

const SEMANTIC_TOP_K = 500;

/**
 * @param {object} options
 * @param {string} options.timelineId
 * @param {Array} options.records raw loreProposals from the Loom's state fence
 * @param {number|string} options.recordedAt when the Archive recorded this turn
 */
export async function applyLoomLoreReports({
    timelineId = '', book = '', records = [], recordedAt = 0, source = {},
    acceptedProse = '', archiveFacts = [], promotionFacts = [],
} = {}) {
    const { accepted: read, rejected } = readLoomInformation(records);

    // Evidence has to come from fiction that was actually accepted. Without
    // this an interrupted turn files lore from the tail the reader never saw,
    // and a retry files lore from the take that was thrown away. Placement
    // decides WHERE information goes; this decides whether it is admissible
    // at all.
    const accepted = [];
    for (let index = 0; index < read.length; index += 1) {
        const information = read[index];
        if (evidenceSource(information.evidence, acceptedProse, archiveFacts, promotionFacts, [], source)) {
            accepted.push(information);
            continue;
        }
        rejected.push({ index, code: 'unsupported-evidence' });
    }
    if (!accepted.length) return summary({ rejected });

    const applied = [];
    const refused = [...rejected];

    for (const information of accepted) {
        // The book comes from the packet the Loom was actually shown. Deriving
        // it again from Timeline settings would file information into a
        // different lorebook than the one the report was made against.
        const lore = await loadTimelineLore(timelineId);
        const target = String(book || lore?.book || '').trim();
        if (!target) { refused.push({ index: -1, code: 'book-unavailable' }); break; }
        const metadata = listLivingLoreMetadata({ timelineId, book: target });

        let semanticMatches = [];
        try {
            const query = await queryWorldSense(timelineId, information.content, { topK: SEMANTIC_TOP_K, threshold: 0 });
            semanticMatches = query?.matches || [];
        } catch {
            // A missing vector costs one of three signals, not the placement.
            // Mentions and time still decide, which is the same degradation
            // retrieval accepts.
            semanticMatches = [];
        }

        const placement = placeLivingLoreInformation({
            content: information.content,
            recordedAt,
            entries: lore?.entries || [],
            metadata,
            semanticMatches,
        });

        const write = await applyLivingLoreIntake({ timelineId, book: target, placement, information, source });
        // loadTimelineLore caches per book, so without this the next record in
        // the same turn would be placed against lore as it was before this
        // write -- which is exactly when two reports concern the same subject.
        invalidateTimelineLoreCache(target);
        if (!write.ok) {
            refused.push({ index: -1, code: write.reason, detail: write.detail || '' });
            continue;
        }
        applied.push({
            writeId: write.writeId || null,
            decision: write.decision,
            book: write.target.book,
            uid: write.target.uid,
            name: write.name,
            score: placement.score,
            signals: placement.signals,
        });
    }

    return summary({ applied, rejected: refused });
}

function summary({ applied = [], rejected = [] } = {}) {
    return Object.freeze({
        ok: true,
        applied: Object.freeze(applied),
        rejected: Object.freeze(rejected),
        appended: applied.filter((item) => item.decision === 'append').length,
        created: applied.filter((item) => item.decision === 'create').length,
    });
}
