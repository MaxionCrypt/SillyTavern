/**
 * Public orchestration boundary for a directed Roleplay turn.
 *
 * The controller owns no generation policy. It gives the UI one stable
 * vocabulary while an adapter supplies the implementation. Commit 1 keeps
 * the legacy Live Direction pipeline as that implementation; later commits
 * can replace one operation at a time without teaching the renderer about
 * engine internals.
 */

function required(implementation, name) {
    const operation = implementation?.[name];
    if (typeof operation !== 'function') {
        throw new TypeError(`Directed turn implementation is missing ${name}().`);
    }
    return operation;
}

function clone(value) {
    if (value == null) return value;
    return structuredClone(value);
}

function freezeDeep(value, seen = new WeakSet()) {
    if (!value || typeof value !== 'object' || seen.has(value)) return value;
    seen.add(value);
    for (const child of Object.values(value)) freezeDeep(child, seen);
    return Object.freeze(value);
}

function immutable(value) {
    return freezeDeep(clone(value));
}

/** @param {object} implementation Legacy or rebuilt directed-turn adapter. */
export function createDirectedTurnController(implementation) {
    const operations = Object.freeze({
        initialize: required(implementation, 'initialize'),
        getRun: required(implementation, 'getRun'),
        getUiState: required(implementation, 'getUiState'),
        start: required(implementation, 'start'),
        continue: required(implementation, 'continue'),
        retry: required(implementation, 'retry'),
        retryFailure: required(implementation, 'retryFailure'),
        stop: required(implementation, 'stop'),
        interrupt: required(implementation, 'interrupt'),
        editAndRerun: required(implementation, 'editAndRerun'),
        recover: required(implementation, 'recover'),
    });
    const listeners = new Set();
    let getActiveScene = () => null;

    const getRun = () => immutable(operations.getRun());
    const getUiState = (scene = getActiveScene()) => immutable(operations.getUiState(scene));
    const getSnapshot = (scene = getActiveScene()) => immutable({
        run: operations.getRun(),
        ui: operations.getUiState(scene),
    });

    function emit(type, scene = getActiveScene()) {
        if (!listeners.size) return;
        const event = immutable({ type, snapshot: {
            run: operations.getRun(),
            ui: operations.getUiState(scene),
        } });
        for (const listener of listeners) listener(event);
    }

    return Object.freeze({
        initialize(hooks = {}) {
            if (typeof hooks.getActiveScene === 'function') getActiveScene = hooks.getActiveScene;
            const onStateChange = hooks.onStateChange;
            return operations.initialize({
                ...hooks,
                onStateChange(run) {
                    onStateChange?.(run);
                    emit('state');
                },
            });
        },
        getRun,
        getUiState,
        getSnapshot,
        subscribe(listener) {
            if (typeof listener !== 'function') throw new TypeError('Directed turn listener must be a function.');
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        start: (options) => operations.start(options),
        continue: (scene) => operations.continue(scene),
        retry: (scene) => operations.retry(scene),
        retryFailure: () => operations.retryFailure(),
        stop: () => operations.stop(),
        interrupt: (draft) => operations.interrupt(draft),
        editAndRerun: (options) => operations.editAndRerun(options),
        async recover() {
            const result = await operations.recover();
            emit('recovered');
            return result;
        },
    });
}
