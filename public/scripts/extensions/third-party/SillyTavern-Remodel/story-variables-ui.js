import {
    OWNER_KINDS,
    STANDARD_RESOURCE_SCALE_BANDS,
    VARIABLE_KINDS,
    createVariableDefinition,
    createVariableInstance,
    deleteVariableDefinition,
    formatVariable,
    getMechanicsProfile,
    getVariableDefinition,
    getVariableStore,
    listMechanicsTransactions,
    listVariableDefinitions,
    listVariableEvents,
    listVariableInstances,
    promoteTimelineDefinition,
    updateMechanicsProfile,
    updateVariableDefinition,
    updateVariableInstance,
    upsertVariableTemplate,
} from './story-variables-store.js';
import { approvePendingMechanics, rejectPendingMechanics, undoMechanicsTransaction } from './mechanics-capabilities.js';
import { getPendingOps, getStoryGoalsStore } from './story-goals-store.js';

const state = { definitionId: '', pane: 'definitions', loreRef: null };

export function renderVariablesWorkspace(timelineStore) {
    const timelineId = timelineStore.activeTimelineId || timelineStore.timelineIds?.[0] || '';
    const definitions = listVariableDefinitions({ includeTimeline: timelineId });
    if (state.definitionId && !definitions.some((item) => item.id === state.definitionId)) state.definitionId = '';
    const selected = definitions.find((item) => item.id === state.definitionId) || null;
    const instances = listVariableInstances({ timelineId });
    const store = getVariableStore();
    const profile = getMechanicsProfile();
    return `
        <section class="remodel-variables-workspace" data-remodel-variables-workspace data-timeline-id="${attr(timelineId)}">
            <aside class="remodel-variable-library">
                <header><span>Mechanical archive</span><h2>Variables</h2><button type="button" data-remodel-variable-action="new" title="New definition"><i class="fa-solid fa-plus"></i></button></header>
                <nav class="remodel-variable-tabs">
                    ${tab('definitions', 'Definitions', 'fa-book-bookmark')}${tab('instances', 'Timeline', 'fa-chart-simple')}${tab('templates', 'Templates', 'fa-stamp')}${tab('history', 'History', 'fa-clock-rotate-left')}${tab('settings', 'Mechanics', 'fa-gears')}
                </nav>
                <div class="remodel-variable-library-list">
                    ${definitions.map((definition) => `<button type="button" class="${state.definitionId === definition.id ? 'is-active' : ''}" data-remodel-variable-definition="${attr(definition.id)}"><i class="fa-solid ${kindIcon(definition.kind)}"></i><span><strong>${html(definition.name)}</strong><small>${html(definition.scope === 'timeline' ? 'Timeline proposal' : `${definition.kind} · ${definition.key}`)}</small></span>${definition.loreRef ? '<i class="fa-solid fa-link"></i>' : ''}</button>`).join('') || '<p class="remodel-variable-empty">No definitions yet. Build the language of this world one Variable at a time.</p>'}
                </div>
            </aside>
            <main class="remodel-variable-editor">
                ${renderPane({ pane: state.pane, selected, definitions, instances, timelineId, store, profile, timelineStore })}
            </main>
        </section>`;
}

export function handleVariableWorkspaceClick(target, requestRender) {
    const tabButton = target.closest('[data-remodel-variable-pane]');
    if (tabButton) { state.pane = tabButton.dataset.remodelVariablePane; requestRender(); return true; }
    const definitionButton = target.closest('[data-remodel-variable-definition]');
    if (definitionButton) { state.definitionId = definitionButton.dataset.remodelVariableDefinition; state.pane = 'definitions'; requestRender(); return true; }
    const action = target.closest('[data-remodel-variable-action]');
    if (!action) return false;
    const workspace = action.closest('[data-remodel-variables-workspace]');
    const timelineId = workspace?.dataset.timelineId || '';
    switch (action.dataset.remodelVariableAction) {
        case 'new': state.definitionId = ''; state.pane = 'definitions'; break;
        case 'save-definition': saveDefinition(workspace, timelineId); break;
        case 'standard-scales': {
            const textarea = workspace?.querySelector('textarea[name="scaleBands"]');
            if (textarea) textarea.value = formatScaleBands(STANDARD_RESOURCE_SCALE_BANDS);
            return true;
        }
        case 'delete-definition': if (state.definitionId && confirm('Delete this unused Variable definition?')) { deleteVariableDefinition(state.definitionId, { timelineId }); state.definitionId = ''; } break;
        case 'promote-definition': { const promoted = promoteTimelineDefinition(timelineId, state.definitionId); if (promoted) state.definitionId = promoted.id; break; }
        case 'create-instance': createInstance(workspace, timelineId); break;
        case 'save-template': saveTemplate(action.dataset.instanceId, timelineId); break;
        case 'save-settings': saveMechanicsSettings(workspace); break;
        case 'approve-pending': approvePendingMechanics(action.dataset.sceneId, action.dataset.pendingId, timelineId); break;
        case 'reject-pending': rejectPendingMechanics(action.dataset.sceneId, action.dataset.pendingId); break;
        case 'undo-transaction': {
            const tx = listMechanicsTransactions({ timelineId }).find((item) => item.id === action.dataset.transactionId);
            if (tx && confirm('Undo this transaction? Existing prose may describe the old outcome.')) undoMechanicsTransaction(tx);
            break;
        }
        default: return false;
    }
    requestRender();
    return true;
}

export function handleVariableWorkspaceChange(target, requestRender) {
    const definitionSelect = target.closest('[data-remodel-variable-instance-definition]');
    if (definitionSelect) {
        populateScaleBandOptions(definitionSelect.closest('[data-remodel-variable-instance-form]'), definitionSelect.value, definitionSelect.closest('[data-remodel-variables-workspace]')?.dataset.timelineId || '');
        return true;
    }
    const instance = target.closest('[data-remodel-variable-instance-value]');
    if (instance) {
        const workspace = instance.closest('[data-remodel-variables-workspace]');
        updateVariableInstance(instance.dataset.remodelVariableInstanceValue, { value: inputValue(instance) }, { timelineId: workspace?.dataset.timelineId, actor: 'user', reason: 'Edited in Variables workspace.' });
        requestRender();
        return true;
    }
    return false;
}

export function selectVariableLoreRef(loreRef) {
    state.loreRef = loreRef;
    state.definitionId = '';
    state.pane = 'definitions';
}

function renderPane(context) {
    switch (context.pane) {
        case 'instances': return renderInstances(context);
        case 'templates': return renderTemplates(context);
        case 'history': return renderHistory(context);
        case 'settings': return renderSettings(context);
        default: return renderDefinitionEditor(context);
    }
}

function renderDefinitionEditor({ selected, timelineId }) {
    const definition = selected || {
        name: '', key: '', kind: 'resource', summary: '', defaultValue: null,
        constraints: { minimum: 0, maximum: null, defaultMaximum: null }, enumStates: [], scaleBands: [],
        reachContribution: { mode: 'none' }, impactScale: {}, loreRef: state.loreRef,
    };
    return `<div class="remodel-variable-pane">
        <header class="remodel-variable-pane-header"><span>${selected ? (selected.scope === 'timeline' ? 'Timeline definition' : 'Account definition') : 'New definition'}</span><h2>${html(selected?.name || 'Define a Variable')}</h2><p>Lorebook prose supplies meaning. Remodel owns every executable rule.</p></header>
        <form class="remodel-variable-form" data-remodel-variable-definition-form>
            <div class="remodel-variable-form-grid">
                ${field('Name', 'name', definition.name, 'text', true)}${field('Stable key', 'key', definition.key)}
                <label>Kind<select name="kind">${VARIABLE_KINDS.map((kind) => `<option value="${kind}" ${kind === definition.kind ? 'selected' : ''}>${kind}</option>`).join('')}</select></label>
                ${definition.kind === 'resource' ? '<label>Instance values<span class="remodel-variable-field-note">Every owner chooses a scale or explicit maximum.</span></label>' : field('Default value', 'defaultValue', definition.defaultValue, definition.kind === 'boolean' ? 'text' : 'number')}
                ${field('Minimum', 'minimum', definition.constraints?.minimum ?? '', 'number')}${definition.kind === 'resource' ? '<label>Universal maximum<span class="remodel-variable-field-note">None. Instances own their scale.</span></label>' : field('Maximum', 'maximum', definition.constraints?.maximum ?? '', 'number')}
                ${field('Lorebook', 'loreBook', definition.loreRef?.book || '')}${field('Entry UID', 'loreUid', definition.loreRef?.uid || '')}
                <label>Reach contribution<select name="reachMode">${['none', 'numeric', 'enum-map', 'boolean-map'].map((mode) => `<option value="${mode}" ${mode === definition.reachContribution?.mode ? 'selected' : ''}>${mode}</option>`).join('')}</select></label>
                ${field('Enum states', 'enumStates', definition.enumStates?.map((item) => item.label).join(', ') || '', 'text')}
            </div>
            <label class="is-wide">Definition summary<textarea name="summary" rows="5" placeholder="What this Variable means, when it matters, and what its states imply…">${html(definition.summary)}</textarea></label>
            ${definition.kind === 'resource' ? `<label class="is-wide">Named scale bands<textarea name="scaleBands" rows="6" placeholder="Ordinary = 20&#10;Formidable = 100&#10;Boss = 500">${html(formatScaleBands(definition.scaleBands))}</textarea><span class="remodel-variable-field-note">One per line: Name = maximum. These are selectable scales, never an automatic default.</span></label><button type="button" data-remodel-variable-action="standard-scales">Use suggested bands</button>` : ''}
            <fieldset><legend>Impact scale</legend>${['minor', 'meaningful', 'major', 'decisive'].map((magnitude) => field(magnitude, `impact_${magnitude}`, definition.impactScale?.[magnitude] ?? '', 'number')).join('')}</fieldset>
            <footer><button type="button" data-remodel-variable-action="save-definition"><i class="fa-solid fa-floppy-disk"></i> ${selected ? 'Save definition' : 'Create definition'}</button>${selected?.scope === 'timeline' ? '<button type="button" data-remodel-variable-action="promote-definition">Promote to account</button>' : ''}${selected ? '<button type="button" class="is-danger" data-remodel-variable-action="delete-definition">Delete</button>' : ''}</footer>
        </form>
        ${!timelineId ? '<p class="remodel-variable-warning">Create a Timeline before making runtime instances.</p>' : ''}
    </div>`;
}

function renderInstances({ instances, definitions, timelineId, timelineStore }) {
    const timeline = timelineStore.timelines[timelineId];
    return `<div class="remodel-variable-pane"><header class="remodel-variable-pane-header"><span>Timeline state</span><h2>${html(timeline?.title || 'No active Timeline')}</h2><p>Definitions supply meaning. Every owner-specific instance supplies its own value and scale.</p></header>
        <form class="remodel-variable-instance-create" data-remodel-variable-instance-form>
            <select name="definitionId" data-remodel-variable-instance-definition><option value="">Definition...</option>${definitions.map((item) => `<option value="${attr(item.id)}">${html(item.name)}</option>`).join('')}</select>
            <select name="ownerKind">${OWNER_KINDS.map((kind) => `<option value="${kind}">${kind}</option>`).join('')}</select>
            <input name="ownerId" placeholder="Stable owner ID"><input name="ownerLabel" placeholder="Display label">
            <select name="scaleBandId" data-remodel-variable-scale-band><option value="">Scale band (optional)</option></select>
            <input name="value" type="number" placeholder="Current value"><input name="maximum" type="number" placeholder="Explicit maximum">
            <button type="button" data-remodel-variable-action="create-instance"><i class="fa-solid fa-plus"></i> Instantiate</button>
        </form>
        <p class="remodel-variable-instance-help">Resources require a named scale band or an explicit maximum. Leaving current value blank starts a Resource full; it never assumes 100.</p>
        <div class="remodel-variable-instance-list">${instances.map((instance) => {
            const definition = getVariableDefinition(instance.definitionId, timelineId);
            const band = definition?.scaleBands?.find((item) => item.id === instance.scaleBandId);
            return `<article><i class="fa-solid ${kindIcon(definition?.kind)}"></i><div><span>${html(instance.ownerRef.label)}</span><strong>${html(definition?.name || 'Unresolved definition')}</strong><small>${html(instance.ownerRef.kind)} | ${html(instance.ownerRef.id)}${band ? ` | ${html(band.label)} scale` : ''}</small></div><input data-remodel-variable-instance-value="${attr(instance.id)}" ${definition?.kind === 'boolean' ? 'type="checkbox"' : definition?.kind === 'enum' ? 'type="text"' : 'type="number"'} ${definition?.kind === 'boolean' ? (instance.value ? 'checked' : '') : `value="${attr(instance.value)}"`}><output>${html(formatVariable(instance))}</output>${['character', 'persona'].includes(instance.ownerRef.kind) ? `<button type="button" title="Save as account template" data-remodel-variable-action="save-template" data-instance-id="${attr(instance.id)}"><i class="fa-solid fa-stamp"></i></button>` : ''}</article>`;
        }).join('') || '<p class="remodel-variable-empty">This Timeline has no Variable instances yet.</p>'}</div></div>`;
}

/* Legacy instance markup retained only as a migration reference.
function renderInstancesLegacy({ instances, definitions, timelineId, timelineStore }) {
    const timeline = timelineStore.timelines[timelineId];
    return `<div class="remodel-variable-pane"><header class="remodel-variable-pane-header"><span>Timeline state</span><h2>${html(timeline?.title || 'No active Timeline')}</h2><p>Runtime values diverge here without changing reusable account definitions.</p></header>
        <form class="remodel-variable-instance-create" data-remodel-variable-instance-form>
            <select name="definitionId"><option value="">Definition…</option>${definitions.map((item) => `<option value="${attr(item.id)}">${html(item.name)}</option>`).join('')}</select>
            <select name="ownerKind">${OWNER_KINDS.map((kind) => `<option value="${kind}">${kind}</option>`).join('')}</select>
            <input name="ownerId" placeholder="Stable owner ID"><input name="ownerLabel" placeholder="Display label"><input name="value" type="number" placeholder="Value"><input name="maximum" type="number" placeholder="Maximum">
            <button type="button" data-remodel-variable-action="create-instance"><i class="fa-solid fa-plus"></i> Instantiate</button>
        </form>
        <div class="remodel-variable-instance-list">${instances.map((instance) => {
            const definition = getVariableDefinition(instance.definitionId, timelineId);
            return `<article><i class="fa-solid ${kindIcon(definition?.kind)}"></i><div><span>${html(instance.ownerRef.label)}</span><strong>${html(definition?.name || 'Unresolved definition')}</strong><small>${html(instance.ownerRef.kind)} · ${html(instance.ownerRef.id)}</small></div><input data-remodel-variable-instance-value="${attr(instance.id)}" ${definition?.kind === 'boolean' ? 'type="checkbox"' : definition?.kind === 'enum' ? 'type="text"' : 'type="number"'} ${definition?.kind === 'boolean' ? (instance.value ? 'checked' : '') : `value="${attr(instance.value)}"`}><output>${html(formatVariable(instance))}</output>${['character', 'persona'].includes(instance.ownerRef.kind) ? `<button type="button" title="Save as account template" data-remodel-variable-action="save-template" data-instance-id="${attr(instance.id)}"><i class="fa-solid fa-stamp"></i></button>` : ''}</article>`;
        }).join('') || '<p class="remodel-variable-empty">This Timeline has no Variable instances yet.</p>'}</div></div>`;
} */

function renderTemplates({ store }) {
    return `<div class="remodel-variable-pane"><header class="remodel-variable-pane-header"><span>Reusable starting state</span><h2>Character & Persona templates</h2><p>Templates copy into a Timeline on first mechanical use; the runtime copy then diverges.</p></header><div class="remodel-variable-record-list">${Object.values(store.templates).map((template) => { const definition = getVariableDefinition(template.definitionId); return `<article><strong>${html(template.ownerRef.label)} · ${html(definition?.name || 'Missing definition')}</strong><span>${html(String(template.value))}${template.maximum == null ? '' : ` / ${html(String(template.maximum))}`}</span><small>${html(template.ownerRef.kind)} · ${html(template.ownerRef.id)}</small></article>`; }).join('') || '<p class="remodel-variable-empty">Use the stamp on a character or persona instance to create a template.</p>'}</div></div>`;
}

function renderHistory({ timelineId }) {
    const events = listVariableEvents({ timelineId }).slice().reverse();
    const transactions = listMechanicsTransactions({ timelineId }).slice().reverse();
    return `<div class="remodel-variable-pane"><header class="remodel-variable-pane-header"><span>Immutable ledger</span><h2>Change history</h2><p>Validated requests, before/after values, rolls, approvals, and rejection reasons remain auditable.</p></header><div class="remodel-variable-record-list">${transactions.map((item) => `<article><strong>${html(item.status)} · ${html(item.protocol)}</strong><span>${item.receipts.length} receipt${item.receipts.length === 1 ? '' : 's'}</span><small>${html(item.createdAt)}</small>${item.undo ? `<button type="button" data-remodel-variable-action="undo-transaction" data-transaction-id="${attr(item.id)}">Undo</button>` : ''}</article>`).join('')}${events.map((item) => `<article><strong>${html(item.type)}</strong><span>${html(item.reason || 'No reason recorded')}</span><small>${html(item.createdAt)}</small></article>`).join('') || '<p class="remodel-variable-empty">No mechanical history in this Timeline.</p>'}</div></div>`;
}

function renderSettings({ profile, store }) {
    const pending = Object.values(getStoryGoalsStore().scenes).flatMap((scene) => getPendingOps(scene.sceneId).map((item) => ({ ...item, sceneId: scene.sceneId }))).filter(Boolean);
    return `<div class="remodel-variable-pane"><header class="remodel-variable-pane-header"><span>Mechanical profile</span><h2>AI adjudication</h2><p>The hidden call uses the current Chat Completion connection. It is not a cast character or Prompt Studio recipe.</p></header><form class="remodel-variable-form" data-remodel-mechanics-form>
        <label class="remodel-variable-toggle"><input type="checkbox" name="enabled" ${profile.enabled ? 'checked' : ''}><span>Run Mechanics before new Roleplay messages</span></label>
        <div class="remodel-variable-form-grid">${field('Context budget', 'contextBudget', profile.contextBudget, 'number')}<label>Automation policy<select name="automationPolicy">${['hybrid', 'review-all', 'automatic'].map((value) => `<option value="${value}" ${profile.automationPolicy === value ? 'selected' : ''}>${value}</option>`).join('')}</select></label><label>Failure behavior<select name="failureBehavior">${['pause', 'bypass', 'retry-once'].map((value) => `<option value="${value}" ${profile.failureBehavior === value ? 'selected' : ''}>${value}</option>`).join('')}</select></label></div>
        <label class="is-wide">Handbook additions<textarea name="handbookAdditions" rows="8" placeholder="World-specific adjudication principles…">${html(profile.handbookAdditions)}</textarea></label>
        <footer><button type="button" data-remodel-variable-action="save-settings"><i class="fa-solid fa-floppy-disk"></i> Save mechanics profile</button></footer></form>
        ${store.legacyReview.length ? `<section class="remodel-variable-review"><span>Migration review</span><h3>Unassigned Legacy Variables</h3>${store.legacyReview.map((item) => `<p><strong>${html(item.ownerLabel)}</strong> · ${html(item.reason)}</p>`).join('')}</section>` : ''}
        ${pending.length ? `<section class="remodel-variable-review"><span>Authority review</span><h3>Pending mechanical proposals</h3>${pending.map((item) => `<article><strong>${html(item.op.capability)}</strong><p>${html(item.op.reason)}</p><button type="button" data-remodel-variable-action="approve-pending" data-scene-id="${attr(item.sceneId)}" data-pending-id="${attr(item.id)}">Approve</button><button type="button" data-remodel-variable-action="reject-pending" data-scene-id="${attr(item.sceneId)}" data-pending-id="${attr(item.id)}">Reject</button></article>`).join('')}</section>` : ''}
    </div>`;
}

function saveDefinition(workspace, timelineId) {
    const form = workspace.querySelector('[data-remodel-variable-definition-form]');
    const data = new FormData(form);
    const kind = String(data.get('kind'));
    const impactScale = Object.fromEntries(['minor', 'meaningful', 'major', 'decisive'].map((key) => [key, numericOrUndefined(data.get(`impact_${key}`))]));
    const input = { name: data.get('name'), key: data.get('key'), kind, summary: data.get('summary'), defaultValue: kind === 'resource' ? null : parseVariableValue(data.get('defaultValue'), kind), constraints: { minimum: numericOrNull(data.get('minimum')), maximum: numericOrNull(data.get('maximum')), defaultMaximum: null }, scaleBands: parseScaleBands(data.get('scaleBands')), enumStates: String(data.get('enumStates') || '').split(',').map((label) => label.trim()).filter(Boolean), loreRef: data.get('loreBook') && data.get('loreUid') ? { book: data.get('loreBook'), uid: data.get('loreUid') } : null, reachContribution: { mode: data.get('reachMode') }, impactScale };
    const current = state.definitionId && getVariableDefinition(state.definitionId, timelineId);
    const saved = current ? updateVariableDefinition(current.id, input, { timelineId: current.timelineId, actor: 'user' }) : createVariableDefinition(input);
    if (saved) { state.definitionId = saved.id; state.loreRef = null; }
}

function createInstance(workspace, timelineId) {
    const data = new FormData(workspace.querySelector('[data-remodel-variable-instance-form]'));
    const definition = getVariableDefinition(data.get('definitionId'), timelineId);
    const scaleBandId = String(data.get('scaleBandId') || '');
    const maximum = numericOrUndefined(data.get('maximum'));
    if (definition?.kind === 'resource' && !scaleBandId && maximum == null) {
        alert('Choose a named scale band or enter an explicit maximum for this Resource instance.');
        return;
    }
    createVariableInstance({ timelineId, definitionId: data.get('definitionId'), ownerRef: { kind: data.get('ownerKind'), id: data.get('ownerId'), label: data.get('ownerLabel') }, scaleBandId, value: numericOrUndefined(data.get('value')), maximum }, { actor: 'user', reason: 'Created in Variables workspace.' });
}

function saveTemplate(instanceId, timelineId) {
    const instance = listVariableInstances({ timelineId }).find((item) => item.id === instanceId);
    if (instance) upsertVariableTemplate({ definitionId: instance.definitionId, ownerRef: instance.ownerRef, value: instance.value, maximum: instance.maximum, scaleBandId: instance.scaleBandId });
}

function saveMechanicsSettings(workspace) {
    const data = new FormData(workspace.querySelector('[data-remodel-mechanics-form]'));
    updateMechanicsProfile({ enabled: data.get('enabled') === 'on', contextBudget: data.get('contextBudget'), automationPolicy: data.get('automationPolicy'), failureBehavior: data.get('failureBehavior'), handbookAdditions: data.get('handbookAdditions') });
}

function tab(id, label, icon) { return `<button type="button" class="${state.pane === id ? 'is-active' : ''}" data-remodel-variable-pane="${id}"><i class="fa-solid ${icon}"></i><span>${label}</span></button>`; }
function field(label, name, value, type = 'text', required = false) { return `<label>${label}<input name="${name}" type="${type}" value="${attr(value ?? '')}" ${required ? 'required' : ''}></label>`; }
function kindIcon(kind) { return ({ resource: 'fa-heart-pulse', number: 'fa-hashtag', enum: 'fa-list', boolean: 'fa-toggle-on' })[kind] || 'fa-diamond'; }
function parseVariableValue(value, kind) { if (kind === 'boolean') return String(value).toLowerCase() === 'true'; return kind === 'enum' ? String(value) : Number(value) || 0; }
function numericOrUndefined(value) { const number = Number(value); return String(value).trim() && Number.isFinite(number) ? number : undefined; }
function numericOrNull(value) { return numericOrUndefined(value) ?? null; }
function inputValue(input) { return input.type === 'checkbox' ? input.checked : input.value; }
function formatScaleBands(bands) { return (bands || []).map((band) => `${band.label} = ${band.maximum}`).join('\n'); }
function parseScaleBands(value) { return String(value || '').split(/\r?\n/).map((line) => { const [label, maximum] = line.split('=').map((part) => part.trim()); return { label, maximum: Number(maximum) }; }).filter((band) => band.label && Number.isFinite(band.maximum) && band.maximum > 0); }
function populateScaleBandOptions(form, definitionId, timelineId) {
    const select = form?.querySelector('[data-remodel-variable-scale-band]');
    if (!select) return;
    const definition = getVariableDefinition(definitionId, timelineId);
    select.innerHTML = `<option value="">Scale band (optional)</option>${(definition?.scaleBands || []).map((band) => `<option value="${attr(band.id)}">${html(band.label)} | ${html(band.maximum)}</option>`).join('')}`;
    select.disabled = definition?.kind !== 'resource' || !definition.scaleBands?.length;
}
function html(value) { return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;'); }
function attr(value) { return html(value).replaceAll('`', '&#096;'); }
