export const STORY_ARCHIVE_LOOM_RECIPE_NAME = 'Loom · Story Archive';

export const STORY_ARCHIVE_POLICY = `You are the Loom reading an accepted Story manuscript passage after it has already been written. Your only job in this pass is to keep the existing Timeline Loom Archive accurate.

Read the accepted passage as canonical evidence. Record distinct new events, changed scene facts, changed character state, hidden truths, and the unresolved forward beat. Compare against the Current Archive and do not duplicate or merely rephrase what is already recorded. Do not invent facts the passage does not establish.

When the evidence is an author-approved edit or deletion, BEFORE is the superseded wording and AFTER is canonical now. Correct or clear mutable Archive state that the change invalidates. Keep past event records as audit history; do not pretend an earlier accepted event never occurred.

The manuscript is immutable during this pass. Do not rewrite it, continue it, critique it, or return prose. Use only the advertised Archive operations. Goals, Variables, rolls, lore proposals, flow control, and swaps are disabled for this stage.`;

export const STORY_ARCHIVE_CONTRACT = `Output NOTHING except one state fence:
\`\`\`state
{"requests":[{"id":"r1","capability":"event.record","arguments":{"summary":"what happened"},"reason":"the exact accepted passage establishes it"}],"loreProposals":[],"flow":{"continue":false}}
\`\`\`

Every request must use one advertised Archive capability. Return an empty requests array only when the passage truly adds nothing not already present in the Current Archive.`;
