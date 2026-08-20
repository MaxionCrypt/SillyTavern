import { getContext } from '../../../st-context.js';
import { streamChatPrompt } from './story-stream.js';

const NS = 'remodel';
const KEY = 'extractionProfileId';
const EXTRACTION_MAX_TOKENS = 2000;

/** The Connection Manager profile id Pass 2 extraction runs on, or '' for the active connection. */
export function getExtractionProfileId() {
    try {
        return String(getContext().extensionSettings?.[NS]?.[KEY] || '');
    } catch {
        return '';
    }
}

/** Set (or clear, with '') the extraction profile id. */
export function setExtractionProfileId(id) {
    const context = getContext();
    context.extensionSettings[NS] ??= {};
    context.extensionSettings[NS][KEY] = id ? String(id) : '';
    context.saveSettingsDebounced?.();
    return context.extensionSettings[NS][KEY];
}

/** The Connection Manager profiles available to choose from, trimmed to what the picker needs. */
export function listExtractionProfiles() {
    try {
        const profiles = getContext().extensionSettings?.connectionManager?.profiles || [];
        return profiles.map((p) => ({ id: p.id, name: p.name, api: p.api, model: p.model }));
    } catch {
        return [];
    }
}

/**
 * Run the Pass 2 extraction transport and return its raw reply text.
 *
 * When an extraction profile is configured (and Connection Manager is enabled),
 * extraction runs on THAT model — so a non-reasoning narrator can pair with a
 * reasoning-capable extractor — without disturbing the narrator's own active
 * connection. Otherwise extraction uses the active connection (the same model
 * the narrator wrote with).
 *
 * @param {object[]} prompt  compiled chat-style messages
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<string>}
 */
export async function runExtraction(prompt, { signal } = {}) {
    const context = getContext();
    const profileId = getExtractionProfileId();
    const service = context.ConnectionManagerRequestService;
    const cmDisabled = Boolean(context.extensionSettings?.disabledExtensions?.includes?.('connection-manager'));
    if (profileId && service && !cmDisabled) {
        const data = await service.sendRequest(profileId, prompt, EXTRACTION_MAX_TOKENS, { stream: false, signal, extractData: true });
        return String(data?.content || '');
    }
    const stream = context.__streamChatPromptStub || streamChatPrompt;
    const result = await stream({ prompt, signal });
    return String(result?.text || '');
}
