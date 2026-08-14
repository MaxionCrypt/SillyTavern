import { recordDebugEvent } from './debug-console.js';

const STORAGE_KEY = 'remodel.liveDirectionFlights.v1';
const MAX_FLIGHTS = 20;
const MAX_EVENTS = 500;
const MAX_STRING = 16000;

let activeFlightId = '';
let installed = false;

function cloneDiagnostic(value, depth = 0) {
    if (depth > 7) return '[depth limit]';
    if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[truncated ${value.length - MAX_STRING}]` : value;
    if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
    if (Array.isArray(value)) return value.slice(0, 120).map((item) => cloneDiagnostic(item, depth + 1));
    if (typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).slice(0, 120).map(([key, item]) => [key, cloneDiagnostic(item, depth + 1)]));
    }
    return String(value);
}

function readStore() {
    try {
        const value = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || '[]');
        return Array.isArray(value) ? value : [];
    } catch {
        return [];
    }
}

function writeStore(flights) {
    try {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(flights.slice(-MAX_FLIGHTS)));
    } catch (error) {
        console.warn('Remodel diagnostics could not persist the flight recorder.', error);
    }
}

function createId() {
    return `flight-${Date.now().toString(36)}-${crypto.randomUUID?.() || Math.random().toString(36).slice(2)}`;
}

function now() {
    return new Date().toISOString();
}

export function beginDirectionFlight(metadata = {}) {
    const flights = readStore();
    const flight = {
        id: createId(),
        status: 'running',
        startedAt: now(),
        endedAt: null,
        metadata: cloneDiagnostic(metadata),
        counters: {},
        events: [],
    };
    flights.push(flight);
    writeStore(flights);
    activeFlightId = flight.id;
    recordDirectionFlight('flight.started', metadata, flight.id);
    return flight.id;
}

export function setActiveDirectionFlight(flightId = '') {
    activeFlightId = String(flightId || '');
}

export function getActiveDirectionFlightId() {
    return activeFlightId;
}

export function recordDirectionFlight(type, detail = {}, flightId = activeFlightId) {
    if (!flightId) return;
    recordDebugEvent('live-direction', type, detail, { correlationId: flightId, summary: type });
    const flights = readStore();
    const flight = flights.find((item) => item.id === flightId);
    if (!flight) return;
    const event = {
        index: flight.events.length,
        at: now(),
        elapsedMs: Math.max(0, Date.now() - Date.parse(flight.startedAt)),
        type: String(type || 'event'),
        detail: cloneDiagnostic(detail),
    };
    flight.events.push(event);
    if (flight.events.length > MAX_EVENTS) flight.events.splice(0, flight.events.length - MAX_EVENTS);
    flight.counters[event.type] = Number(flight.counters[event.type] || 0) + 1;
    writeStore(flights);
    window.dispatchEvent(new CustomEvent('remodel-live-direction-diagnostic', { detail: { flightId, event } }));
}

export function finishDirectionFlight(status = 'complete', detail = {}, flightId = activeFlightId) {
    if (!flightId) return;
    recordDirectionFlight('flight.finished', { status, ...cloneDiagnostic(detail) }, flightId);
    const flights = readStore();
    const flight = flights.find((item) => item.id === flightId);
    if (flight) {
        flight.status = String(status || 'complete');
        flight.endedAt = now();
        writeStore(flights);
    }
    if (activeFlightId === flightId) activeFlightId = '';
}

export function getDirectionFlights() {
    return structuredClone(readStore());
}

export function getDirectionFlight(flightId = activeFlightId) {
    const flight = readStore().find((item) => item.id === flightId);
    return flight ? structuredClone(flight) : null;
}

export function clearDirectionFlights() {
    sessionStorage.removeItem(STORAGE_KEY);
    activeFlightId = '';
}

export function downloadDirectionFlights() {
    const blob = new Blob([JSON.stringify({ exportedAt: now(), flights: readStore() }, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `remodel-live-direction-${new Date().toISOString().replaceAll(':', '-')}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

export function installLiveDirectionDiagnostics() {
    if (installed) return;
    installed = true;
    const api = Object.freeze({
        list: getDirectionFlights,
        get: getDirectionFlight,
        clear: clearDirectionFlights,
        download: downloadDirectionFlights,
        active: () => activeFlightId,
    });
    Object.defineProperty(window, 'RemodelLiveDirectionDiagnostics', { value: api, configurable: true });
    window.addEventListener('error', (event) => recordDirectionFlight('window.error', { message: event.message, error: event.error }));
    window.addEventListener('unhandledrejection', (event) => recordDirectionFlight('window.unhandledrejection', { reason: event.reason }));
}
