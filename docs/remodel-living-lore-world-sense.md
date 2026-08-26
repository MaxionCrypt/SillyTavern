# Living Lore and World Sense

World Sense helps a Timeline retrieve and maintain its own lorebook. Native
World Info remains the source of truth; Remodel stores only revision,
protection, link, retrieval, proposal, and audit metadata beside it.

## Set it up

1. Assign a writable lorebook to the Timeline.
2. Open **Lorebooks > World Sense**.
3. Leave the local model at its default or choose another Transformers model.
4. Select a mode:
   - **Off** keeps native World Info only.
   - **Observe** retrieves lore without accepting Loom proposals.
   - **Suggest** retrieves lore and sends validated changes to review.
   - **Auto-safe** automatically applies only allowlisted, high-confidence
     changes backed by accepted prose or committed Archive facts.
5. Select **Reindex** after changing the embedding model. Ordinary lore edits
   are indexed incrementally.

The first model load can take several seconds. Roleplay fails open to native
keyword World Info if the model is downloading, offline, or unavailable.

## Cultivate a seed

Select a seed entry in World Sense. Use **Protected fields** to lock Identity
and Established premise text while leaving Open threads available to grow.

The cultivation tools do not call a remote model and do not write directly:

- **Grow this seed** drafts an open hook.
- **Find related lore** ranks existing entries semantically.
- **Check contradictions** warns about exact duplicate keys/claims and simple
  opposite-polarity claims. Warnings are lint, not declarations of canon.
- **Update from scene** drafts a current-state change.
- The pointed-action form can also draft an established fact, create an entry,
  or create a typed link.

Inspect the exact proposal preview, send it to the review queue, then Apply,
Edit, or Reject it. Applied changes retain a field-level audit and rollback.

## Auto-safe boundaries

Auto-safe is opt-in. Its default allowlist is `fact.append`, `alias.add`,
`entry.link`, and `current.set`, with a 0.92 confidence threshold. Both are
editable in World Sense.

Auto-safe never automatically applies creation, retirement, deletion, identity
or premise replacement, owner cultivation drafts, low-confidence changes,
competing current-state changes, untrusted evidence, or values resembling API
credentials or prompt-control tokens. Protected fields and stale revisions are
still enforced by the same atomic mutation engine. A failed automatic batch
remains reviewable and cannot fail the roleplay turn.

## Inspect and recover

The Debug workspace records World Sense retrieval receipts, degradation,
proposal decisions, automatic applications, transaction failures, and index
recovery. A retrieval receipt identifies the target Scene mode, query-source
labels and character counts, every lore or continuity record included in the
prompt, its ranking reasons, and the source Scene mode. Story Archive receipts
also identify the document revision, exact source span and hash, mechanics
transaction outcome, and queued or rejected lore proposals. Prompt bodies
remain subject to the existing sensitive-transcript setting.

If search looks stale, use **Reindex**. A query that receives unknown vector
identities or a corrupt/missing collection rebuilds the Timeline collection
once and retries. Repeated failure returns to native keyword retrieval rather
than blocking narration.

## Mixed-mode recorder journeys

Start the Debug recorder before opening the first Scene. Keep the Story status,
Roleplay stage feedback, and Debug receipt visible where possible. Run one
journey per recording so a failure has one causal path.

1. **Roleplay Continue into Story:** establish a named fact with Continue in a
   Roleplay Scene, open a later Story Scene in another Arc, and generate one
   beat. The Story retrieval receipt must include the Roleplay source Scene and
   exact Archive record; the manuscript must not contain Debug or prompt text.
2. **Story beat into Roleplay:** generate and accept a Story beat that changes a
   character pressure, wait for **Saved · Archived**, then Continue in a later
   Roleplay Scene. Its receipt must include the Story source record and any
   linked Goal or Variable created by Story ingestion.
3. **Manual prose and Catch up:** type after the last Story Narrator passage,
   preview **Catch up Archive**, accept it, wait for Archive completion, reload,
   and preview again. Only the exact manual span is ingested and the second
   preview has no duplicate change.
4. **Regeneration:** regenerate an accepted Story beat. The prior capture and
   its unapplied lore suggestions become superseded, its mechanics transaction
   is rolled back, and only the replacement remains eligible for recall.
5. **Stop:** stop Story generation while prose is streaming. The accepted
   manuscript prefix remains visible, and no unseen tail or unsupported Archive
   consequence is captured. Repeat Stop during Roleplay and confirm the visible
   Loom prefix remains the canonical response.
6. **Recall controls:** disable look-back, pin one exact earlier record, and
   exclude another source Scene. Preview and Send must agree: the pin appears,
   the excluded Scene does not, and a separate Timeline retrieves neither.
7. **Conflict recovery:** queue a lore suggestion, edit that lore entry before
   applying it, then Apply. The stale revision is rejected visibly; refreshing
   and re-running retrieval produces a new revisioned suggestion rather than a
   silent overwrite.
8. **Reload recovery:** reload while a Story Archive capture is queued or after
   a provider failure. Reopening the Scene resumes only the unapplied capture,
   caps automatic retries, and never duplicates an already-applied receipt.

For Suggest and Auto-safe coverage, verify `proposal.queued`,
`auto-safe.applied`, `transaction.applied`, the Story Web receipt when
applicable, and the corresponding retrieval receipt all carry the expected
Timeline, source Scene, and document revision.
