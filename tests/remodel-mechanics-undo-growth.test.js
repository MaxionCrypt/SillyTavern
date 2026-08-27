// Regression: a mechanics transaction's `undo` snapshot must NOT embed the
// transaction ledger. The ledger lives in the same store, so capturing it into
// each transaction's own undo made every new transaction embed all prior
// undos — the store doubled per transaction and blew up to ~83MB across 29
// transactions, POSTed on every settings save, freezing the app.
import { test, expect, beforeEach } from '@jest/globals';
import { MECHANICS_PROTOCOL, executeMechanicsRequest } from '../public/scripts/extensions/third-party/SillyTavern-Remodel/mechanics-capabilities.js';
import {
    listMechanicsTransactions,
    snapshotVariableStore,
    snapshotVariableStoreForUndo,
    restoreVariableStore,
    listVariableValues,
} from '../public/scripts/extensions/third-party/SillyTavern-Remodel/variables-store.js';
import { __setExtensionSettings } from './util/st-context-stub.js';

const TL = 'tl-undo';
const SC = 'sc-undo';

beforeEach(() => __setExtensionSettings({ remodel: {} }));

function createVar(i) {
    return executeMechanicsRequest(
        {
            protocol: MECHANICS_PROTOCOL,
            requests: [{
                id: `r${i}`, capability: 'variable.create',
                arguments: { name: `V${i}`, valueType: 'number', value: i, description: 'd', minimum: 0, maximum: 100 },
                reason: 'seed',
            }],
        },
        { timelineId: TL, sceneId: SC, variableRefs: new Map(), goalRefs: new Map() },
    );
}

test("a transaction's undo snapshot never embeds the transaction ledger", () => {
    for (let i = 0; i < 6; i += 1) createVar(i);
    const txs = listMechanicsTransactions({ timelineId: TL });
    expect(txs).toHaveLength(6);
    for (const tx of txs) {
        expect(tx.undo.variables.transactions).toBeUndefined();
        expect(tx.undo.variables.transactionIds).toBeUndefined();
    }
});

test('the whole store stays small across many transactions — no exponential blow-up', () => {
    for (let i = 0; i < 10; i += 1) createVar(i);
    const storeBytes = JSON.stringify(snapshotVariableStore()).length;
    // 10 trivial transactions grow the store LINEARLY (a var + an event each) —
    // tens of KB. With the ledger-embedding bug this doubled per transaction
    // into megabytes (the field wild data hit 83MB at 29). 200KB cleanly
    // separates the two: linear-fixed stays well under, exponential-buggy blows
    // far past.
    expect(storeBytes).toBeLessThan(200 * 1024);
});

test('keeps recent rollback checkpoints while compacting older transaction snapshots', () => {
    for (let i = 0; i < 20; i += 1) createVar(i);
    const txs = listMechanicsTransactions({ timelineId: TL });
    expect(txs).toHaveLength(20);
    expect(txs.slice(0, 8).every((tx) => tx.undo === undefined && tx.undoExpired === true)).toBe(true);
    expect(txs.slice(-12).every((tx) => tx.undo?.variables && tx.undo?.goals)).toBe(true);
});

test('restoring an undo snapshot rolls back values but keeps the live ledger', () => {
    createVar(0);
    createVar(1);
    const snap = snapshotVariableStoreForUndo();   // taken with 2 transactions, V0 & V1
    createVar(2);                                   // a 3rd transaction, adds V2
    expect(listVariableValues({ timelineId: TL }).some((v) => v.name === 'V2')).toBe(true);

    restoreVariableStore(snap, { save: false });

    // Values rolled back — V2 is gone…
    expect(listVariableValues({ timelineId: TL }).some((v) => v.name === 'V2')).toBe(false);
    // …but the transaction ledger was preserved, not wiped to the snapshot's.
    expect(listMechanicsTransactions({ timelineId: TL }).length).toBeGreaterThanOrEqual(3);
});
