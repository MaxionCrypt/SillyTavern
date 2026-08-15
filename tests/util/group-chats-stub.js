// Test stub for SillyTavern's group-chats.js.
//
// Importing it for real pulls in utils.js, RossAscends-mods.js,
// request-compression.js and others, several of which resolve modules by an
// absolute browser-root path (e.g. `import { Fuse } from '../lib.js'` chains
// into request-compression.js importing '/lib.js'), which Node cannot resolve
// under Jest. live-direction.js only reaches two bindings from this module;
// everything else about native group generation is exercised through the
// live app, not this test suite.
//
// Deliberately minimal: inert values with no behaviour, following the same
// pattern as script-stub.js.

export let is_group_generating = false;

export async function generateGroupWrapper() {}
