import { getContext } from '../../../st-context.js';
import {
    doNavbarIconClick,
    doNewChat,
    getPastCharacterChats,
} from '../../../../script.js';
import {
    CHAT_METADATA_KEY,
    createArc,
    createScene,
    createTimeline,
    deleteArc,
    deleteScene,
    deleteTimeline,
    getActiveTimeline,
    getScene,
    getSceneFromMetadata,
    getTimelineStore,
    setActiveScene,
    setActiveTimeline,
    updateArc,
    updateScene,
    updateTimeline,
} from './timeline-state.js';

const DRAWER_ID = 'remodel-timeline-drawer';
const PANEL_ID = 'remodel-timeline-panel';
const CONTENT_ID = 'remodel-timeline-content';
const LEGACY_OUTLET_ID = 'remodel-tavern-legacy-outlet';
const TAVERN_TABS = [
    {
        id: 'timeline',
        label: 'Timeline',
        icon: 'fa-diagram-project',
    },
    {
        id: 'characters',
        label: 'Characters',
        icon: 'fa-address-card',
        panelId: 'right-nav-panel',
    },
    {
        id: 'personas',
        label: 'Personas',
        icon: 'fa-face-smile',
        panelId: 'PersonaManagement',
    },
    {
        id: 'lorebooks',
        label: 'Lorebooks',
        icon: 'fa-book-atlas',
        panelId: 'WorldInfo',
    },
];

let initialized = false;
let renderQueued = false;
let activeTavernTab = 'timeline';
let adoptedPanel = null;
let tavernPanelObserver = null;
const originalPanelHomes = new Map();

export function initTimelineSpine({ onDrawerReady } = {}) {
    if (initialized) {
        return;
    }

    const drawer = ensureTimelineDrawer();
    bindDrawerToggle(drawer);
    bindTimelineEvents(drawer);
    bindSillyTavernEvents();
    observeTavernPanelState();
    initialized = true;

    onDrawerReady?.(drawer);
    renderTimelinePanel();
}

function ensureTimelineDrawer() {
    const existingDrawer = document.getElementById(DRAWER_ID);

    if (existingDrawer) {
        return existingDrawer;
    }

    const drawer = document.createElement('div');
    drawer.id = DRAWER_ID;
    drawer.className = 'drawer';
    drawer.innerHTML = `
        <div class="drawer-toggle" tabindex="0" role="button" aria-label="Open Tavern">
            <div class="drawer-icon fa-solid fa-beer-mug-empty fa-fw closedIcon" title="Tavern"></div>
        </div>
        <div id="${PANEL_ID}" class="drawer-content closedDrawer remodel-timeline-drawer-content">
            <div id="${CONTENT_ID}" class="remodel-timeline-content"></div>
        </div>
    `;

    const holder = document.getElementById('top-settings-holder');
    const firstDrawer = holder?.querySelector(':scope > .drawer');

    if (firstDrawer) {
        firstDrawer.before(drawer);
    } else {
        holder?.append(drawer);
    }

    return drawer;
}

function bindDrawerToggle(drawer) {
    const toggle = drawer.querySelector(':scope > .drawer-toggle');

    toggle?.addEventListener('click', async (event) => {
        event.preventDefault();
        await doNavbarIconClick.call(toggle);
        syncTavernViewportState();
        queueRender();
    });

    toggle?.addEventListener('keydown', async (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') {
            return;
        }

        event.preventDefault();
        await doNavbarIconClick.call(toggle);
        syncTavernViewportState();
        queueRender();
    });
}

function syncTavernViewportState() {
    const panel = document.getElementById(PANEL_ID);
    const isOpen = panel?.classList.contains('openDrawer') || false;
    document.body.classList.toggle('remodel-tavern-active', isOpen);

    if (!isOpen) {
        restoreAdoptedPanel();
    }
}

function observeTavernPanelState() {
    if (tavernPanelObserver) {
        return;
    }

    const panel = document.getElementById(PANEL_ID);

    if (!panel) {
        return;
    }

    tavernPanelObserver = new MutationObserver(syncTavernViewportState);
    tavernPanelObserver.observe(panel, {
        attributes: true,
        attributeFilter: ['class'],
    });
    syncTavernViewportState();
}

function bindTimelineEvents(drawer) {
    drawer.addEventListener('click', async (event) => {
        const tavernTab = event.target instanceof Element
            ? event.target.closest('[data-remodel-tavern-tab]')
            : null;

        if (tavernTab) {
            event.preventDefault();
            event.stopPropagation();
            activeTavernTab = tavernTab.dataset.remodelTavernTab || 'timeline';
            queueRender();
            return;
        }

        const actionElement = event.target instanceof Element
            ? event.target.closest('[data-remodel-timeline-action]')
            : null;

        if (!actionElement) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();
        await handleAction(actionElement);
    });

    drawer.addEventListener('change', async (event) => {
        const field = event.target instanceof Element
            ? event.target.closest('[data-remodel-timeline-field]')
            : null;

        if (!field) {
            return;
        }

        await handleFieldChange(field);
    });
}

function bindSillyTavernEvents() {
    const context = getContext();

    context.eventSource.on(context.eventTypes.CHAT_CHANGED, syncActiveSceneFromChatMetadata);
    context.eventSource.on(context.eventTypes.CHAT_LOADED, syncActiveSceneFromChatMetadata);
}

async function handleAction(element) {
    const action = element.dataset.remodelTimelineAction;

    switch (action) {
        case 'create-timeline': {
            const title = askForTitle('Timeline title?', 'New Timeline');
            if (title) {
                createTimeline(title);
            }
            break;
        }
        case 'select-timeline':
            setActiveTimeline(element.dataset.timelineId);
            break;
        case 'delete-timeline':
            if (confirm('Delete this Timeline and all of its Arcs and Scenes?')) {
                deleteTimeline(element.dataset.timelineId);
            }
            break;
        case 'create-arc': {
            const title = askForTitle('Arc title?', 'New Arc');
            if (title) {
                createArc(element.dataset.timelineId, title);
            }
            break;
        }
        case 'delete-arc':
            if (confirm('Delete this Arc and all of its Scenes?')) {
                deleteArc(element.dataset.arcId);
            }
            break;
        case 'create-scene': {
            const fallback = element.dataset.mode === 'story' ? 'New Story Scene' : 'New Roleplay Scene';
            const title = askForTitle('Scene title?', fallback);
            if (title) {
                createScene(element.dataset.arcId, element.dataset.mode, title);
            }
            break;
        }
        case 'select-scene':
            setActiveScene(element.dataset.sceneId);
            break;
        case 'delete-scene':
            if (confirm('Delete this Scene? The underlying SillyTavern chat will not be deleted.')) {
                deleteScene(element.dataset.sceneId);
            }
            break;
        case 'bind-current':
            bindCurrentChatToScene(element.dataset.sceneId);
            break;
        case 'new-scene-chat':
            await createNewChatForScene(element.dataset.sceneId);
            break;
        case 'open-scene':
            await openScene(element.dataset.sceneId);
            break;
        default:
            break;
    }

    queueRender();
}

function askForTitle(message, fallback) {
    const title = prompt(message, fallback);

    if (title === null) {
        return null;
    }

    return title.trim() || fallback;
}

async function handleFieldChange(field) {
    const fieldName = field.dataset.remodelTimelineField;
    const value = field.value;

    switch (fieldName) {
        case 'timeline-title':
            updateTimeline(field.dataset.timelineId, { title: value });
            break;
        case 'timeline-description':
            updateTimeline(field.dataset.timelineId, { description: value });
            break;
        case 'arc-title':
            updateArc(field.dataset.arcId, { title: value });
            break;
        case 'arc-summary':
            updateArc(field.dataset.arcId, { summary: value });
            break;
        case 'scene-title':
            updateScene(field.dataset.sceneId, { title: value });
            break;
        case 'scene-mode':
            updateScene(field.dataset.sceneId, { mode: value });
            break;
        case 'scene-status':
            updateScene(field.dataset.sceneId, { status: value });
            break;
        case 'scene-summary':
            updateScene(field.dataset.sceneId, { summary: value });
            break;
        default:
            break;
    }

    queueRender();
}

function renderTimelinePanel() {
    const content = document.getElementById(CONTENT_ID);

    if (!content) {
        return;
    }

    const store = getTimelineStore();
    const timeline = getActiveTimeline();

    content.innerHTML = `
        <div class="remodel-tavern-viewport">
            <header class="remodel-tavern-header">
                <h1>Silly Tavern</h1>
            </header>
            <nav class="remodel-tavern-tabs" aria-label="Tavern sections">
                ${renderTavernTabs()}
            </nav>
            <div class="remodel-tavern-body">
                ${activeTavernTab === 'timeline' ? renderTimelineWorkspace(store, timeline) : renderLegacyWorkspace()}
            </div>
        </div>
    `;

    if (activeTavernTab === 'timeline') {
        restoreAdoptedPanel();
    } else {
        adoptLegacyPanel(activeTavernTab);
    }
}

function renderTavernTabs() {
    return TAVERN_TABS.map((tab) => `
        <button
            type="button"
            class="remodel-tavern-tab ${activeTavernTab === tab.id ? 'is-active' : ''}"
            data-remodel-tavern-tab="${escapeAttribute(tab.id)}"
        >
            <i class="fa-solid ${escapeAttribute(tab.icon)}" aria-hidden="true"></i>
            <span>${escapeHtml(tab.label)}</span>
        </button>
    `).join('');
}

function renderTimelineWorkspace(store, timeline) {
    return `
        <section class="remodel-tavern-section remodel-tavern-timeline-section">
            <div class="remodel-timeline-header">
                <div>
                    <div class="remodel-timeline-kicker">Structure</div>
                    <h3>Timeline</h3>
                </div>
                <button type="button" class="menu_button" data-remodel-timeline-action="create-timeline">New</button>
            </div>
            ${renderTimelineSelector(store)}
            ${timeline ? renderTimeline(timeline, store) : renderEmptyState()}
        </section>
    `;
}

function renderLegacyWorkspace() {
    const tab = TAVERN_TABS.find((item) => item.id === activeTavernTab);

    return `
        <section class="remodel-tavern-section remodel-tavern-legacy-section">
            <div class="remodel-timeline-header">
                <div>
                    <div class="remodel-timeline-kicker">Workspace</div>
                    <h3>${escapeHtml(tab?.label || 'Tavern')}</h3>
                </div>
            </div>
            <div id="${LEGACY_OUTLET_ID}" class="remodel-tavern-legacy-outlet"></div>
        </section>
    `;
}

function renderTimelineSelector(store) {
    if (!store.timelineIds.length) {
        return '';
    }

    return `
        <div class="remodel-timeline-tabs" role="list" aria-label="Timelines">
            ${store.timelineIds.map((timelineId) => {
        const timeline = store.timelines[timelineId];
        const isActive = store.activeTimelineId === timelineId;
        return `
                    <button
                        type="button"
                        class="remodel-timeline-tab ${isActive ? 'is-active' : ''}"
                        data-remodel-timeline-action="select-timeline"
                        data-timeline-id="${escapeAttribute(timelineId)}"
                    >${escapeHtml(timeline?.title || 'Untitled')}</button>
                `;
    }).join('')}
        </div>
    `;
}

function adoptLegacyPanel(tabId) {
    const tab = TAVERN_TABS.find((item) => item.id === tabId);
    const outlet = document.getElementById(LEGACY_OUTLET_ID);
    const panel = tab?.panelId ? document.getElementById(tab.panelId) : null;

    if (!outlet || !panel) {
        restoreAdoptedPanel();
        outlet?.append(renderMissingLegacyPanel(tab?.label || 'Panel'));
        return;
    }

    if (adoptedPanel && adoptedPanel !== panel) {
        restoreAdoptedPanel();
    }

    if (!originalPanelHomes.has(panel)) {
        originalPanelHomes.set(panel, {
            parent: panel.parentElement,
            nextSibling: panel.nextSibling,
        });
    }

    adoptedPanel = panel;
    panel.classList.add('remodel-tavern-adopted-panel', 'openDrawer');
    panel.classList.remove('closedDrawer', 'remodel-side-left', 'remodel-side-right');
    outlet.append(panel);
}

function restoreAdoptedPanel() {
    if (!adoptedPanel) {
        return;
    }

    const panel = adoptedPanel;
    const home = originalPanelHomes.get(panel);

    panel.classList.remove('remodel-tavern-adopted-panel', 'openDrawer');
    panel.classList.add('closedDrawer');

    if (home?.parent) {
        home.parent.insertBefore(panel, home.nextSibling);
    }

    adoptedPanel = null;
}

function renderMissingLegacyPanel(label) {
    const missing = document.createElement('div');
    missing.className = 'remodel-timeline-empty compact';
    missing.textContent = `${label} is not available yet.`;
    return missing;
}

function renderTimeline(timeline, store) {
    const activeScene = timeline.activeSceneId ? store.scenes[timeline.activeSceneId] : null;

    return `
        <section class="remodel-timeline-editor">
            <label>
                <span>Timeline title</span>
                <input
                    type="text"
                    value="${escapeAttribute(timeline.title)}"
                    data-remodel-timeline-field="timeline-title"
                    data-timeline-id="${escapeAttribute(timeline.id)}"
                >
            </label>
            <label>
                <span>Description</span>
                <textarea
                    rows="3"
                    data-remodel-timeline-field="timeline-description"
                    data-timeline-id="${escapeAttribute(timeline.id)}"
                >${escapeHtml(timeline.description || '')}</textarea>
            </label>
            <div class="remodel-timeline-actions">
                <button type="button" class="menu_button" data-remodel-timeline-action="create-arc" data-timeline-id="${escapeAttribute(timeline.id)}">Add Arc</button>
                <button type="button" class="menu_button danger" data-remodel-timeline-action="delete-timeline" data-timeline-id="${escapeAttribute(timeline.id)}">Delete Timeline</button>
            </div>
        </section>
        <section class="remodel-timeline-tree">
            ${timeline.arcIds.map((arcId) => renderArc(store.arcs[arcId], store, timeline)).join('') || renderNoArcs()}
        </section>
        ${activeScene ? renderSceneInspector(activeScene) : ''}
    `;
}

function renderArc(arc, store, timeline) {
    if (!arc) {
        return '';
    }

    return `
        <article class="remodel-timeline-arc ${timeline.activeArcId === arc.id ? 'is-active' : ''}">
            <div class="remodel-timeline-arc-heading">
                <input
                    type="text"
                    value="${escapeAttribute(arc.title)}"
                    data-remodel-timeline-field="arc-title"
                    data-arc-id="${escapeAttribute(arc.id)}"
                    aria-label="Arc title"
                >
                <button type="button" class="remodel-icon-button" title="Delete Arc" data-remodel-timeline-action="delete-arc" data-arc-id="${escapeAttribute(arc.id)}">×</button>
            </div>
            <textarea
                rows="2"
                placeholder="Arc summary"
                data-remodel-timeline-field="arc-summary"
                data-arc-id="${escapeAttribute(arc.id)}"
            >${escapeHtml(arc.summary || '')}</textarea>
            <div class="remodel-scene-list">
                ${arc.sceneIds.map((sceneId) => renderSceneRow(store.scenes[sceneId], timeline)).join('') || '<div class="remodel-timeline-muted">No scenes yet.</div>'}
            </div>
            <div class="remodel-timeline-actions">
                <button type="button" class="menu_button" data-remodel-timeline-action="create-scene" data-mode="roleplay" data-arc-id="${escapeAttribute(arc.id)}">+ Roleplay</button>
                <button type="button" class="menu_button" data-remodel-timeline-action="create-scene" data-mode="story" data-arc-id="${escapeAttribute(arc.id)}">+ Story</button>
            </div>
        </article>
    `;
}

function renderSceneRow(scene, timeline) {
    if (!scene) {
        return '';
    }

    const isActive = timeline.activeSceneId === scene.id;
    const bindingLabel = getLinkedChatLabel(scene);

    return `
        <div class="remodel-scene-row ${isActive ? 'is-active' : ''} ${scene.status === 'missing' ? 'is-missing' : ''}">
            <button
                type="button"
                class="remodel-scene-main"
                data-remodel-timeline-action="select-scene"
                data-scene-id="${escapeAttribute(scene.id)}"
            >
                <span class="remodel-scene-title">${escapeHtml(scene.title)}</span>
                <span class="remodel-scene-meta">
                    <span class="remodel-mode-pill ${scene.mode}">${escapeHtml(scene.mode)}</span>
                    <span>${escapeHtml(bindingLabel)}</span>
                </span>
            </button>
            <button type="button" class="remodel-icon-button" title="Open Scene" data-remodel-timeline-action="open-scene" data-scene-id="${escapeAttribute(scene.id)}">↗</button>
        </div>
    `;
}

function renderSceneInspector(scene) {
    const missing = scene.status === 'missing';

    return `
        <section class="remodel-scene-inspector ${missing ? 'is-missing' : ''}">
            <div class="remodel-scene-inspector-heading">
                <div>
                    <div class="remodel-timeline-kicker">Active Scene</div>
                    <strong>${escapeHtml(scene.title)}</strong>
                </div>
                <button type="button" class="remodel-icon-button" title="Delete Scene" data-remodel-timeline-action="delete-scene" data-scene-id="${escapeAttribute(scene.id)}">×</button>
            </div>
            ${missing ? '<div class="remodel-timeline-warning">Linked chat is missing. Rebind this Scene to the current chat to recover it.</div>' : ''}
            <label>
                <span>Scene title</span>
                <input type="text" value="${escapeAttribute(scene.title)}" data-remodel-timeline-field="scene-title" data-scene-id="${escapeAttribute(scene.id)}">
            </label>
            <div class="remodel-two-column-fields">
                <label>
                    <span>Mode</span>
                    <select data-remodel-timeline-field="scene-mode" data-scene-id="${escapeAttribute(scene.id)}">
                        <option value="roleplay" ${scene.mode === 'roleplay' ? 'selected' : ''}>Roleplay</option>
                        <option value="story" ${scene.mode === 'story' ? 'selected' : ''}>Story</option>
                    </select>
                </label>
                <label>
                    <span>Status</span>
                    <select data-remodel-timeline-field="scene-status" data-scene-id="${escapeAttribute(scene.id)}">
                        ${['unbound', 'active', 'draft', 'complete', 'missing'].map((status) => `<option value="${status}" ${scene.status === status ? 'selected' : ''}>${status}</option>`).join('')}
                    </select>
                </label>
            </div>
            <label>
                <span>Summary</span>
                <textarea rows="4" data-remodel-timeline-field="scene-summary" data-scene-id="${escapeAttribute(scene.id)}">${escapeHtml(scene.summary || '')}</textarea>
            </label>
            <div class="remodel-linked-chat-card">
                <span>${escapeHtml(getLinkedChatLabel(scene))}</span>
            </div>
            <div class="remodel-timeline-actions">
                <button type="button" class="menu_button" data-remodel-timeline-action="open-scene" data-scene-id="${escapeAttribute(scene.id)}">Open</button>
                <button type="button" class="menu_button" data-remodel-timeline-action="bind-current" data-scene-id="${escapeAttribute(scene.id)}">Bind Current</button>
                <button type="button" class="menu_button" data-remodel-timeline-action="new-scene-chat" data-scene-id="${escapeAttribute(scene.id)}">New Chat</button>
            </div>
        </section>
    `;
}

function renderEmptyState() {
    return `
        <div class="remodel-timeline-empty">
            <h4>No Timelines yet</h4>
            <p>Create a Timeline to start organizing chats into Arcs and Scenes.</p>
            <button type="button" class="menu_button" data-remodel-timeline-action="create-timeline">Create Timeline</button>
        </div>
    `;
}

function renderNoArcs() {
    return '<div class="remodel-timeline-empty compact">No Arcs yet. Add one to start building Scenes.</div>';
}

async function openScene(sceneId) {
    const scene = getScene(sceneId);

    if (!scene?.linkedChat) {
        updateScene(sceneId, { status: 'unbound' });
        return;
    }

    const context = getContext();
    const linkedChat = scene.linkedChat;

    if (linkedChat.type === 'group') {
        const group = context.groups.find((item) => String(item.id) === String(linkedChat.groupId));

        if (!group || !group.chats.includes(linkedChat.chatId)) {
            updateScene(sceneId, { status: 'missing' });
            return;
        }

        setActiveScene(sceneId);
        await context.openGroupChat(linkedChat.groupId, linkedChat.chatId);
        writeSceneMetadata(scene);
        updateScene(sceneId, { status: 'active' });
        return;
    }

    const characterId = Number(linkedChat.characterId);

    if (!context.characters[characterId]) {
        updateScene(sceneId, { status: 'missing' });
        return;
    }

    const characterChats = await getPastCharacterChats(characterId);
    const hasChat = characterChats.some((chat) => String(chat.file_name).replace(/\.jsonl$/i, '') === linkedChat.fileName);

    if (!hasChat) {
        updateScene(sceneId, { status: 'missing' });
        return;
    }

    setActiveScene(sceneId);
    await context.selectCharacterById(characterId, { switchMenu: false });
    await context.openCharacterChat(linkedChat.fileName);
    writeSceneMetadata(scene);
    updateScene(sceneId, { status: 'active' });
}

function bindCurrentChatToScene(sceneId) {
    const scene = getScene(sceneId);
    const linkedChat = getCurrentLinkedChat();

    if (!scene || !linkedChat) {
        alert('Open a character or group chat before binding this Scene.');
        return;
    }

    const updatedScene = updateScene(sceneId, {
        linkedChat,
        status: 'active',
    });

    setActiveScene(sceneId);
    writeSceneMetadata(updatedScene);
}

async function createNewChatForScene(sceneId) {
    const scene = getScene(sceneId);

    if (!scene) {
        return;
    }

    await doNewChat();
    bindCurrentChatToScene(sceneId);
}

function getCurrentLinkedChat() {
    const context = getContext();

    if (context.groupId && context.chatId) {
        return {
            type: 'group',
            groupId: String(context.groupId),
            chatId: String(context.chatId),
        };
    }

    if (context.characterId !== undefined && context.characterId !== null && context.chatId) {
        return {
            type: 'character',
            characterId: String(context.characterId),
            fileName: String(context.chatId),
        };
    }

    return null;
}

function writeSceneMetadata(scene) {
    if (!scene) {
        return;
    }

    const context = getContext();
    context.chatMetadata[CHAT_METADATA_KEY] = {
        timelineId: scene.timelineId,
        arcId: scene.arcId,
        sceneId: scene.id,
        mode: scene.mode,
        title: scene.title,
        linkedChat: scene.linkedChat,
        updatedAt: new Date().toISOString(),
    };
    context.saveMetadataDebounced();
}

function syncActiveSceneFromChatMetadata() {
    const scene = getSceneFromMetadata(getContext().chatMetadata?.[CHAT_METADATA_KEY]);

    if (!scene) {
        queueRender();
        return;
    }

    setActiveScene(scene.id);
    queueRender();
}

function getLinkedChatLabel(scene) {
    if (!scene.linkedChat) {
        return 'No chat bound';
    }

    if (scene.status === 'missing') {
        return 'Missing chat';
    }

    if (scene.linkedChat.type === 'group') {
        return `Group · ${scene.linkedChat.chatId}`;
    }

    return `Character · ${scene.linkedChat.fileName}`;
}

function queueRender() {
    if (renderQueued) {
        return;
    }

    renderQueued = true;
    requestAnimationFrame(() => {
        renderQueued = false;
        renderTimelinePanel();
    });
}

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function escapeAttribute(value) {
    return escapeHtml(value);
}
