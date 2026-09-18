// Render seam for the Selected Living Lore packet. The untyped "information
// report" intake (buildLivingLorePacket / parseLivingLoreProposals and its
// validators) is retired: the Loom now edits and creates lore through typed
// loreOps, and pulls more into scope through loreKeywords. This module only
// renders the bounded packet the Loom reasons over, plus that contract.

/** Render one recipe source with both the writable packet and its output rule. */
export function formatLivingLorePacket(packet) {
    if (!packet?.book || !Array.isArray(packet.entries)) return '';
    const lorePacket = { ...packet };
    delete lorePacket.promotion;
    return [
        'Selected Living Lore (what the world already records about this scene):',
        JSON.stringify(lorePacket, null, 2),
        'Do not rewrite lore inside the prose. When accepted fiction changes one of these entries, add a top-level "loreOps" array to the state fence with a "lore.edit" op naming that entry\'s book and uid and giving its full new content.',
        'When accepted fiction establishes a meaningfully reusable new subject that no entry above covers, add a "lore.create" op giving name, keys, and content; the new entry lands in the timeline book.',
        'Shape: {"loreOps":[{"id":"o1","op":"lore.edit","arguments":{"book":"...","uid":"...","content":"the full entry text after the change"},"reason":"why, one line"}]}.',
        'You may only edit an entry that is in the Selected Living Lore above. To change one that is not, first name its key in "loreKeywords" to pull it in; a lore.edit whose book/uid is not in scope is refused.',
        'Leave "loreOps" empty when accepted fiction changed no durable fact.',
        'The lore above is what this Scene is working from. To pull more in, add a top-level "loreKeywords" array of GROUPS, each group an array of the exact keys to look up together: {"loreKeywords":[["Queens Lake University"],["event","Marissa"]]}.',
        'Use the exact key an entry answers to. Partial names do not match: "Queens" will not find "Queens Lake University". An entry that needs several keys is pulled only when they are named together in one group.',
        'What you pull stays available for the Scene, so ask only for what a moment needs. Leave "loreKeywords" out when the current lore still serves.',
    ].filter(Boolean).join('\n');
}
