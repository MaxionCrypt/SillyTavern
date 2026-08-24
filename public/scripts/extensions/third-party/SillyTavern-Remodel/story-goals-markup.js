// Story Goals — the owner's authoring markup.
//
// Kept out of story-goals.js so it can be asserted offline: that module reaches
// the native macro engine through its imports, which does not resolve under
// Node, so anything left in it is untestable by construction. The same reason
// direction-sources.js and narrator-history.js are their own modules.
//
// Pure string builders. No DOM, no store, no I/O.

import { STORY_GOAL_STATUSES, STORY_GOAL_VISIBILITIES, formatHolders } from './story-goals-model.js';

export function escapeHtml(value) {
    return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

export function escapeAttribute(value) {
    return escapeHtml(value).replaceAll('`', '&#096;');
}

/** The shared tarot-card face used by both the deck and Goal detail view. */
export function renderGoalCardFaceMarkup(goal, numeral) {
    const secret = goal.visibility === 'secret';
    const multipleHolders = (goal.holderRefs?.length || goal.holders?.length || 0) > 1;
    const glyph = secret ? 'fa-user-secret' : multipleHolders ? 'fa-people-group' : 'fa-bullseye';
    return `
        <span class="remodel-goal-card-numeral">${escapeHtml(numeral)}</span>
        <span class="remodel-goal-card-glyph"><i class="fa-solid ${glyph}" aria-hidden="true"></i></span>
        <span class="remodel-goal-card-plate">
            <span class="remodel-goal-card-rate">${escapeHtml(goal.successRate)}<small>%</small></span>
            <span class="remodel-goal-card-holder">${escapeHtml(formatHolders(goal))}</span>
        </span>`;
}

/**
 * The owner's edit form: every attribute the record holds, in one place.
 *
 * Owner edits go straight to the store rather than through the capability
 * layer — that layer exists to constrain a model, not its owner — so they
 * produce no receipt. The submit handler passes actor 'user' so the event
 * ledger can still tell an owner edit from a Loom change.
 *
 * The status and visibility options are derived from the model's own lists
 * rather than spelled out here, so a value added there appears without anyone
 * remembering to edit this file.
 */
export function renderGoalEditFormMarkup(goal) {
    const option = (value, current) => `<option value="${escapeAttribute(value)}"${value === current ? ' selected' : ''}>${escapeHtml(value)}</option>`;
    return `
        <form class="remodel-goal-edit-form" data-remodel-goal-edit-form="${escapeAttribute(goal.id)}">
            <label>Title<input name="title" required value="${escapeAttribute(goal.title)}"></label>
            <label>Description<textarea name="description" rows="3">${escapeHtml(goal.description || '')}</textarea></label>
            <label>Held by<input name="holder" value="${escapeAttribute(formatHolders(goal))}"></label>
            <label>Success rate<input name="successRate" type="number" min="5" max="95" value="${escapeAttribute(String(goal.successRate))}"></label>
            <label>Status<select name="status">${STORY_GOAL_STATUSES.map((value) => option(value, goal.status)).join('')}</select></label>
            <label>Visibility<select name="visibility">${STORY_GOAL_VISIBILITIES.map((value) => option(value, goal.visibility)).join('')}</select></label>
            <div class="remodel-goal-edit-actions">
                <button type="button" data-remodel-goal-edit-cancel>Cancel</button>
                <button type="submit">Save</button>
            </div>
        </form>`;
}

/** Existing relationships, and a way to relate this Goal to another in the Scene. */
export function renderGoalRelationsMarkup(goal, goals, relations = []) {
    const mine = relations.filter((relation) => relation.fromGoalId === goal.id || relation.toGoalId === goal.id);
    const others = goals.filter((item) => item.id !== goal.id);
    const titleOf = (id) => goals.find((item) => item.id === id)?.title || 'a Goal elsewhere';
    return `
        <div class="remodel-goal-relations">
            ${mine.map((relation) => `<span class="remodel-goal-relation is-${escapeAttribute(relation.type)}">${escapeHtml(titleOf(relation.fromGoalId))} &rarr; ${escapeHtml(titleOf(relation.toGoalId))}</span>`).join('')}
            ${others.length ? `
                <form class="remodel-goal-relate-form" data-remodel-goal-relate-form="${escapeAttribute(goal.id)}">
                    <select name="toGoalId">${others.map((item) => `<option value="${escapeAttribute(item.id)}">${escapeHtml(item.title)}</option>`).join('')}</select>
                    <select name="type"><option value="antagonistic">works against</option><option value="sympathetic">helps</option></select>
                    <input name="reason" placeholder="Why (optional)">
                    <button type="submit">Relate</button>
                </form>` : ''}
        </div>`;
}
