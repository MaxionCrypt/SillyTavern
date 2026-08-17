import {
    formatHolders,
} from './story-goals-model.js';
import { getSceneGoalState, getSceneGoals, updateSceneGoalState } from './story-goals-store.js';
import { registerStoryStatMacros } from './story-stats-macros.js';

// Story Goals — the roleplay-facing surface.
//
// This file owns the floating viewport the GOALS pill raises over the centre
// chat: a tarot-card deck of the Timeline goals linked to this Scene, and a
// codex-style detail view for one goal. Goals are Timeline-owned and linked to
// Scenes for presentation, so leaving a Scene does not destroy their memory.
// Manual creation lives here; AI changes are accepted only through the
// validated capability protocol used by Live Direction.

const hooks = {
    getActiveScene: () => null,
    getCast: () => [],
    getPersona: () => null,
    requestRender: () => {},
    sendNative: () => {},
    showToast: () => {},
};

const uiState = {
    initialized: false,
    // Which goal's detail is open (a goalId) vs the deck (absent), per scene.
    viewGoalByScene: new Map(),
    composerIntents: new Map(),
};

/** timeline-spine checks this to avoid tearing down the turn UI between legs. */
export function isStoryPipelineRunning() {
    return false;
}

export function initStoryGoals(options = {}) {
    Object.assign(hooks, Object.fromEntries(Object.entries(options).filter(([, value]) => typeof value === 'function')));
    if (uiState.initialized) {
        return;
    }
    bindStoryGoalEvents();
    // Read-only {{stat::…}} / {{statdef::…}} macros, plus the async warm-up of
    // the lorebook type text they read synchronously.
    registerStoryStatMacros();

    uiState.initialized = true;
}

/** Goals attached to the composer for adjudication — a later increment. */
// Explicit Goal intents attached to the next directed Roleplay intervention.
export function getStoryGoalComposerIntents(sceneId = '') {
    return [...(uiState.composerIntents.get(String(sceneId || '')) || [])];
}

export function formatStoryGoalsPrompt(scene) {
    if (!scene?.id) return '';
    const goals = getSceneGoals(scene.id, { includeResolved: false, states: ['active', 'background'] });
    if (!goals.length) return '';
    const publicLines = goals.filter((goal) => goal.visibility !== 'secret').map((goal) => `- ${goal.title} (${goal.successRate}%; held by ${formatHolders(goal)}): ${goal.description || 'No description.'}`);
    const secretLines = goals.filter((goal) => goal.visibility === 'secret').map((goal) => `- Pursue privately: ${goal.title} (${goal.successRate}%; held by ${formatHolders(goal)}). ${goal.description || ''} Never announce this Goal merely because it appears here.`);
    return [publicLines.length ? `[Public Story Goals]\n${publicLines.join('\n')}` : '', secretLines.length ? `[Private behavioral Goals — do not disclose]\n${secretLines.join('\n')}` : ''].filter(Boolean).join('\n\n');
}

// The former cast-character Director and fenced `loom` protocol have been
// retired. The only mechanical preflight is now the hidden schema-constrained
// call in mechanics-runtime.js.

/**
 * The send path.
 *
 * A Scene staged as 'free' sends exactly as it always has — this returns
 * immediately down the native path and nothing below runs. Only a 'directed'
 * Scene enters the pipeline.
 */
export async function handleGoalAwareRoleplaySend({ scene, text, sendNative }) {
    // The standalone per-message Mechanical AI is retired. timeline-spine
    // routes Directed Scenes to live-direction.js before reaching this seam;
    // Free Scenes stay on SillyTavern's native send path.
    sendNative();
    return true;
}

export function renderStoryGoalsForRoleplay(root, scene) {
    if (!root || !scene) return;
    renderStoryGoalViewport(root, scene);
}

// Roll/clash event cards on native messages arrive with the Director.
export function decorateStoryGoalStream() {}

// --- the floating Story Goals viewport (tarot-card deck) -------------------

// Which goal's detail is open (a goalId) vs the deck (null).
function getViewGoalId(sceneId) {
    return uiState.viewGoalByScene.get(String(sceneId)) || null;
}

function setViewGoalId(sceneId, goalId) {
    if (goalId) uiState.viewGoalByScene.set(String(sceneId), goalId);
    else uiState.viewGoalByScene.delete(String(sceneId));
}

function isStoryGoalViewportOpen(sceneId) {
    return Boolean(getSceneGoalState(sceneId, { create: false })?.boardOpen);
}

// Owns the floating viewport the GOALS pill raises over the center chat. When
// open, a root class hides the message stream; this element carries the
// tarot-card deck or a single goal's detail.
function renderStoryGoalViewport(root, scene) {
    let viewport = root.querySelector('[data-remodel-goals-viewport]');
    if (!viewport) {
        viewport = document.createElement('div');
        viewport.className = 'remodel-goals-viewport';
        viewport.dataset.remodelGoalsViewport = '';
        root.appendChild(viewport);
    }
    const open = isStoryGoalViewportOpen(scene.id);
    document.querySelector('[data-remodel-rp-panel-toggle="goals"]')?.classList.toggle('is-active', open);
    root.classList.toggle('remodel-goals-viewport-open', open);
    viewport.hidden = !open;
    if (!open) {
        viewport.innerHTML = '';
        // Keep viewGoalId so reopening returns to the same card's detail if one
        // was open — closing should not lose your place.
        return;
    }
    const goals = getSceneGoals(scene.id, { includeResolved: true, states: ['active', 'background'] });
    const viewGoal = getViewGoalId(scene.id) ? goals.find((goal) => goal.id === getViewGoalId(scene.id)) : null;
    viewport.classList.toggle('is-detail', Boolean(viewGoal));
    viewport.innerHTML = `
        <button type="button" class="remodel-goal-viewport-close" data-remodel-goal-viewport-close aria-label="Close Story Goals"><i class="fa-solid fa-xmark"></i></button>
        ${viewGoal ? renderGoalDetailMarkup(viewGoal, goals) : renderGoalDeckMarkup(goals)}`;
}

function renderGoalDeckMarkup(goals) {
    return `
        <div class="remodel-goal-deck-view">
            <div class="remodel-goal-tarot-deck">
                ${goals.map((goal, index) => renderGoalTarotCard(goal, index)).join('') || `
                    <div class="remodel-goal-empty">
                        <span>Story Goals</span>
                        <strong>No goals have been brought into this scene.</strong>
                        <p>The prototype cards have been removed. Goal creation will return after the timeline-owned system is designed.</p>
                    </div>`}
            </div>
            <button type="button" class="remodel-goal-create-button" data-remodel-goal-create><i class="fa-solid fa-plus"></i> New Story Goal</button>
            <div class="remodel-goal-hover-name" data-remodel-goal-hover-name aria-live="polite"></div>
        </div>`;
}

// The face of a tarot goal card (numeral, glyph, rate plate) — shared by the
// clickable deck card and the large display card in the detail view.
function goalCardFace(goal, numeral) {
    const secret = goal.visibility === 'secret';
    return `
        <span class="remodel-goal-card-numeral">${numeral}</span>
        <span class="remodel-goal-card-glyph"><i class="fa-solid ${secret ? 'fa-user-secret' : goalGlyph(goal)}" aria-hidden="true"></i></span>
        <span class="remodel-goal-card-plate">
            <span class="remodel-goal-card-rate">${goal.successRate}<small>%</small></span>
            <span class="remodel-goal-card-holder">${escapeHtml(formatHolders(goal))}</span>
        </span>`;
}

// A self-contained tarot goal card (does NOT depend on timeline-card internals).
// Per-goal hue derived from the id so the deck varies.
function renderGoalTarotCard(goal, index) {
    const secret = goal.visibility === 'secret';
    return `
        <button type="button" class="remodel-goal-card${secret ? ' is-secret' : ''}" style="--goal-hue:${goalHue(goal)}"
            data-remodel-goal-card="${escapeAttribute(goal.id)}" data-remodel-goal-name="${escapeAttribute(secret ? 'A hidden goal' : goal.title)}"
            aria-label="${escapeAttribute(secret ? 'Secret goal' : goal.title)}">
            ${goalCardFace(goal, toRomanNumeral(index + 1))}
        </button>`;
}

// Goal detail — the codex/archive layout (mirrors the timeline archive view):
// the goal's card rendered large at the left, an editorial column at the right
// with the display title and numbered record rows.
function renderGoalDetailMarkup(goal, goals) {
    const index = Math.max(0, goals.indexOf(goal));
    const rows = [];
    rows.push({ label: 'Success rate', value: `${goal.successRate}%`, sub: 'The chance a determined reach lands.' });
    rows.push({
        label: 'Held by',
        value: formatHolders(goal),
        sub: (goal.holderRefs?.length || goal.holders?.length || 0) > 1 ? 'A shared goal — one rate held between them.' : '',
    });
    rows.push({ label: 'Token', value: goal.token, sub: goal.status });
    return `
        <div class="remodel-goal-detail-view">
            <div class="remodel-goal-detail-layout">
                <article class="remodel-goal-card is-display" style="--goal-hue:${goalHue(goal)}">
                    ${goalCardFace(goal, toRomanNumeral(index + 1))}
                </article>
                <div class="remodel-goal-detail-info">
                    <div class="remodel-goal-detail-topline">
                        <button type="button" class="remodel-goal-back" data-remodel-goal-deck-back aria-label="Back to deck"><i class="fa-solid fa-arrow-left"></i></button>
                        <span class="remodel-goal-kicker">Story Goal · ${escapeHtml(goal.status)}</span>
                    </div>
                    <h2 class="remodel-goal-detail-name">${escapeHtml(goal.title)}</h2>
                    ${goal.description ? `<p class="remodel-goal-detail-summary">${escapeHtml(goal.description)}</p>` : ''}
                    <div class="remodel-goal-detail-records">
                        ${rows.map((row, i) => `
                            <div class="remodel-goal-detail-row">
                                <span class="remodel-goal-detail-num">${String(i + 1).padStart(2, '0')}</span>
                                <span class="remodel-goal-detail-label">${escapeHtml(row.label)}</span>
                                <span class="remodel-goal-detail-value">${escapeHtml(row.value)}</span>
                                ${row.sub ? `<span class="remodel-goal-detail-sub">${escapeHtml(row.sub)}</span>` : ''}
                            </div>`).join('')}
                    </div>
                </div>
            </div>
        </div>`;
}

// Choose a minimal glyph per goal so cards read as varied symbols.
function goalGlyph(goal) {
    if ((goal.holderRefs?.length || goal.holders?.length || 0) > 1) return 'fa-people-group';
    return 'fa-bullseye';
}

// Deterministic per-goal hue (0–360) from the id, so the deck's card colors are
// varied but stable across re-renders.
function goalHue(goal) {
    const id = String(goal?.id || '');
    let hash = 0;
    for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) % 360;
    return hash;
}

function toRomanNumeral(n) {
    const table = [[10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
    let out = '';
    let value = Math.max(1, Math.min(39, Number(n) || 1));
    for (const [amount, symbol] of table) {
        while (value >= amount) { out += symbol; value -= amount; }
    }
    return out;
}

function safePersonaName() {
    try {
        return getContext().name1 || 'You';
    } catch {
        return 'You';
    }
}

// --- events ----------------------------------------------------------------

function bindStoryGoalEvents() {
    document.addEventListener('click', (event) => {
        const target = event.target instanceof Element ? event.target : null;
        const scene = hooks.getActiveScene();
        const root = document.getElementById('remodel-roleplay-root');
        if (!target || !scene || scene.mode !== 'roleplay' || !root) return;

        const intentButton = target.closest('[data-remodel-goal-intent]');
        if (intentButton) {
            const goalId = intentButton.dataset.remodelGoalIntent;
            const intents = getStoryGoalComposerIntents(scene.id);
            const exists = intents.some((item) => item.goalId === goalId);
            uiState.composerIntents.set(String(scene.id), exists ? intents.filter((item) => item.goalId !== goalId) : [...intents, { goalId, mode: 'attempt' }]);
            hooks.requestRender();
            return;
        }

        if (target.closest('[data-remodel-goal-create]')) {
            openManualGoalCreator(root, scene);
            return;
        }

        if (target.closest('[data-remodel-rp-panel-toggle="goals"]')) {
            const state = getSceneGoalState(scene.id, { timelineId: scene.timelineId });
            updateSceneGoalState(scene.id, { boardOpen: !state.boardOpen }, { timelineId: scene.timelineId });
            hooks.requestRender();
            return;
        }

        const viewport = root.querySelector('[data-remodel-goals-viewport]');
        if (!viewport || viewport.hidden) return;

        // Corner cancel: close the viewport, restore chat + composer.
        if (target.closest('[data-remodel-goal-viewport-close]')) {
            updateSceneGoalState(scene.id, { boardOpen: false }, { timelineId: scene.timelineId });
            hooks.requestRender();
            return;
        }
        // Back to the deck from a goal's detail.
        if (target.closest('[data-remodel-goal-deck-back]')) {
            setViewGoalId(scene.id, null);
            hooks.requestRender();
            return;
        }
        // Click a deck card: open that goal's detail.
        const card = target.closest('[data-remodel-goal-card]');
        if (card) {
            setViewGoalId(scene.id, card.dataset.remodelGoalCard);
            hooks.requestRender();
        }
    }, true);

    // Hovering a deck card floats that goal's name at the fixed point.
    document.addEventListener('mouseover', (event) => {
        const scene = hooks.getActiveScene();
        if (!scene || scene.mode !== 'roleplay') return;
        const card = event.target instanceof Element ? event.target.closest('[data-remodel-goal-card]') : null;
        if (!card) return;
        const label = document.querySelector('[data-remodel-goal-hover-name]');
        if (label) {
            label.textContent = card.dataset.remodelGoalName || '';
            label.classList.add('is-visible');
        }
    }, true);

    document.addEventListener('mouseout', (event) => {
        const card = event.target instanceof Element ? event.target.closest('[data-remodel-goal-card]') : null;
        if (!card) return;
        const label = document.querySelector('[data-remodel-goal-hover-name]');
        if (label && !event.relatedTarget?.closest?.('[data-remodel-goal-card]')) {
            label.classList.remove('is-visible');
        }
    }, true);
}

function openManualGoalCreator(root, scene) {
    root.querySelector('[data-remodel-goal-create-form]')?.remove();
    const form = document.createElement('form');
    form.className = 'remodel-goal-create-form';
    form.dataset.remodelGoalCreateForm = '';
    form.innerHTML = `<button type="button" data-remodel-goal-create-close aria-label="Close">×</button><span>New Story Goal</span><input name="title" required placeholder="Goal title"><textarea name="description" rows="4" placeholder="Desired outcome and what makes it unresolved"></textarea><input name="holder" required value="${escapeAttribute(hooks.getPersona?.()?.label || 'You')}" placeholder="Holder"><input name="target" placeholder="Target (optional)"><label>Opening chance<input name="rate" type="number" min="5" max="95" value="50"></label><label>Visibility<select name="visibility"><option value="public">Public</option><option value="secret">Secret</option></select></label><button type="submit">Create Goal</button>`;
    form.addEventListener('click', (event) => { if (event.target.closest('[data-remodel-goal-create-close]')) form.remove(); });
    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const data = new FormData(form);
        const persona = hooks.getPersona?.() || { kind: 'persona', id: 'user', label: String(data.get('holder') || 'You') };
        const { createTimelineGoal } = await import('./story-goals-store.js');
        createTimelineGoal(scene.timelineId, { title: data.get('title'), description: data.get('description'), successRate: data.get('rate'), visibility: data.get('visibility'), holderRefs: [{ ...persona, label: String(data.get('holder') || persona.label) }], targetRefs: data.get('target') ? [{ kind: 'custom', id: `custom-${String(data.get('target')).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, label: data.get('target') } ] : [] }, { sceneId: scene.id, actor: 'user', reason: 'Created explicitly from the Story Goals board.' });
        form.remove();
        hooks.requestRender();
    });
    root.querySelector('[data-remodel-goals-viewport]')?.append(form);
}

function escapeHtml(value) {
    return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

function escapeAttribute(value) {
    return escapeHtml(value).replaceAll('`', '&#096;');
}
