// Compatibility surface for the Variables feature. Lore-entry identity is a
// shared Living Lore concern now, but existing imports keep their old names.
export {
    loreEntryKey as entryKey,
    sameLoreEntry as sameEntry,
} from './living-lore-model.js';
