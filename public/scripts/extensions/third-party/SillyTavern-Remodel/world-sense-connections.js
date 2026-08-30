// What an entry is connected to, and why.
//
// The mesh is derived, not authored: there is no stored list of relationships
// to read back. Every connection is a consequence of one entry's content naming
// another's key, so the only honest way to show them is to rebuild the graph
// and report what it says, with the key that caused each link.
//
// Three kinds of connection, matching what traversal walks:
//
// A connection is this entry's content naming another's key, in that direction
// only. Being named BY another entry is not shown, and neither is sharing a
// parent with one: the walk follows neither, so listing them would describe
// reachability the system does not have.
//
// Pure. No store, no model, no network.

import { assignLoreTiers, buildLoreMentionGraph, scoreLoreGenerality } from './lore-hierarchy.js';
import { buildMesh } from './lore-traversal.js';

export const CONNECTION_RELATIONS = Object.freeze(['names']);

const RELATION_LABELS = Object.freeze({ 'names': 'names' });

export function describeConnectionRelation(relation) {
    return RELATION_LABELS[String(relation || '')] || String(relation || '');
}

/**
 * Every entry's immediate neighbourhood, so the whole shape can be read at
 * once rather than one entry at a time.
 *
 * @param {Array} entries live lore entries
 * @returns {Array<{key: string, name: string, tier: ?number, isolated: boolean, neighbours: Array}>}
 */
export function describeLoreConnections(entries = []) {
    const live = entries.filter((entry) => entry && !entry.native?.disable);
    if (!live.length) return [];

    const graph = buildLoreMentionGraph(live);
    const mesh = buildMesh(graph);
    const byId = new Map(live.map((entry) => [graphId(entry), entry]));
    const tierById = new Map(assignLoreTiers(scoreLoreGenerality(live, { graph })).map((item) => [item.id, item.tier]));

    return live.map((entry) => {
        const id = graphId(entry);
        const neighbours = (mesh.get(id) || [])
            .filter((link) => byId.has(link.to))
            .map((link) => ({
                key: entryKey(byId.get(link.to)),
                name: byId.get(link.to).name || '',
                relation: link.relation,
                // The key whose match created this link: the evidence for the
                // connection, and the word to edit if it is wrong.
                via: String(link.key || ''),
                tier: tierById.has(link.to) ? tierById.get(link.to) : null,
            }))
            .sort((left, right) => order(left.relation) - order(right.relation)
                || String(left.name).localeCompare(String(right.name)));

        return {
            key: entryKey(entry),
            name: entry.name || '',
            tier: tierById.has(id) ? tierById.get(id) : null,
            // An isolated entry can only ever arrive by being named in the
            // scene itself; nothing will ever walk to it.
            isolated: neighbours.length === 0,
            neighbours,
        };
    }).sort((left, right) => right.neighbours.length - left.neighbours.length
        || String(left.name).localeCompare(String(right.name)));
}

/** One entry's neighbourhood. */
export function describeEntryConnections(entry, entries = []) {
    const wanted = entryKey(entry);
    return describeLoreConnections(entries).find((item) => item.key === wanted)
        || { key: wanted, name: entry?.name || '', tier: null, isolated: true, neighbours: [] };
}

function order(relation) {
    const index = CONNECTION_RELATIONS.indexOf(relation);
    return index < 0 ? CONNECTION_RELATIONS.length : index;
}

function graphId(entry) {
    return `${entry?.book || ''}::${entry?.uid || ''}`;
}

function entryKey(entry) {
    return `${entry?.book || ''}.${entry?.uid || ''}`;
}
