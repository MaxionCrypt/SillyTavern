// Jest stub for public/scripts/world-info.js.
//
// The real module transitively imports browser-only UI code (RossAscends-mods
// / templates -> public/lib.js -> @iconfu/svg-inject), which references `window`
// and cannot load under the node test environment. This stub exports the names
// the extension imports from world-info.js, with test-settable globals.

export let selected_world_info = [];
export let world_names = [];
export let world_info = { charLore: [] };
export let world_info_case_sensitive = false;
export let world_info_match_whole_words = false;

export const DEFAULT_DEPTH = 4;
export const world_info_budget = 25;
export const world_info_budget_cap = 0;
export const world_info_character_strategy = 0;
export const world_info_depth = 2;
export const world_info_include_names = true;
export const world_info_insertion_strategy = 1;
export const world_info_max_recursion_steps = 0;
export const world_info_min_activations = 0;
export const world_info_min_activations_depth_max = 0;
export const world_info_overflow_alert = false;
export const world_info_position = 0;
export const world_info_recursive = false;
export const world_info_use_group_scoring = false;
export const world_info_logic = Object.freeze({ AND_ANY: 0, NOT_ALL: 1, NOT_ANY: 2, AND_ALL: 3 });

export async function loadWorldInfo() { return null; }
export async function getWorldInfoEntriesForBook() { return []; }

// Test helper: mutate the live-binding globals this stub exports.
export function __setWorldInfoState(patch = {}) {
    if ('selected_world_info' in patch) selected_world_info = patch.selected_world_info;
    if ('world_names' in patch) world_names = patch.world_names;
    if ('world_info' in patch) world_info = patch.world_info;
    if ('world_info_case_sensitive' in patch) world_info_case_sensitive = patch.world_info_case_sensitive;
    if ('world_info_match_whole_words' in patch) world_info_match_whole_words = patch.world_info_match_whole_words;
}
