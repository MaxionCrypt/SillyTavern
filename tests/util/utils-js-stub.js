// Test stub for SillyTavern's scripts/utils.js.
//
// Importing it for real pulls in extensions.js, popup.js, power-user.js,
// group-chats.js, world-info.js and more — a large, DOM-dependent graph.
// variables-vector.js reaches exactly one binding from this module, to build
// a cache key for a vector query.
//
// Anchored to the exact three-level-up specifier Remodel's own files use, not
// a bare basename suffix — utils.js is a common filename and a loose pattern
// risks capturing an unrelated file elsewhere in the tree (the openai.js
// precedent in jest.config.json exists for the same reason).
//
// getStringHash is copied verbatim rather than left inert: it is pure,
// dependency-free, and small enough that copying it removes any risk of the
// stub silently drifting from the real hash instead of merely approximating
// it.

/**
 * A fast and simple 53-bit string hash function with decent collision resistance.
 * Verbatim copy of scripts/utils.js's implementation — see there for provenance.
 * @param {string} str The string to hash.
 * @param {number} [seed=0] The seed to use for the hash.
 * @returns {number} The hash code.
 */
export function getStringHash(str, seed = 0) {
    if (typeof str !== 'string') {
        return 0;
    }

    let h1 = 0xdeadbeef ^ seed,
        h2 = 0x41c6ce57 ^ seed;
    for (let i = 0, ch; i < str.length; i++) {
        ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }

    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);

    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}
