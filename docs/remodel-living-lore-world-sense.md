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
recovery. Prompt bodies remain subject to the existing sensitive-transcript
setting.

If search looks stale, use **Reindex**. A query that receives unknown vector
identities or a corrupt/missing collection rebuilds the Timeline collection
once and retries. Repeated failure returns to native keyword retrieval rather
than blocking narration.

For a manual acceptance run, keep the session recorder attached, exercise one
Suggest proposal and one Auto-safe proposal, then verify `proposal.queued`,
`auto-safe.applied`, `transaction.applied`, and the corresponding retrieval
receipt share the expected Timeline and direction context.
