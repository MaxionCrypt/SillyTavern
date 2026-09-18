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
        'You may only edit an entry that is in the Selected Living Lore above. To reach one that is not, name its key in "loreKeywords" to bring it into scope for a later turn; a lore.edit whose book/uid is not in scope is refused.',
        'An entry marked "secret":true is on the table for you but hidden from the Narrator. Reveal it when the fiction brings it into the open with a lore.edit carrying "secret":false; hide an entry with "secret":true, or create one hidden with "secret":true on lore.create.',
        'Leave "loreOps" empty when accepted fiction changed no durable fact.',
        'The lore above is this Scene\'s current working set. To change it, add a top-level "loreKeywords" array of GROUPS naming exactly what to have on the table next; this REPLACES the whole set, it does not add to it: {"loreKeywords":[["Queens Lake University"],["event","Marissa"]]}.',
        'Use the exact key an entry answers to. Partial names do not match: "Queens" will not find "Queens Lake University". An entry that needs several keys is pulled only when they are named together in one group.',
        'Because it replaces, include every group the coming turns need, not only what is new. Leave "loreKeywords" out or empty to keep the current set unchanged.',
    ].filter(Boolean).join('\n');
}
