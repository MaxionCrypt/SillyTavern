let profiles = new Map();

/** Seed the profiles reasoning-policy code resolves against. */
export function __setConnectionProfiles(list = []) {
    profiles = new Map((Array.isArray(list) ? list : []).map((profile) => [String(profile.id), profile]));
}

export class ConnectionManagerRequestService {
    static constructPrompt(prompt) {
        return prompt;
    }

    static async sendRequest() {
        return '';
    }

    static getProfile(profileId) {
        const profile = profiles.get(String(profileId || ''));
        if (!profile) throw new Error(`Unknown connection profile: ${profileId}`);
        return profile;
    }

    static validateProfile(profile) {
        // Mirrors the real service's shape: `selected` is the API boundary and
        // `source` the chat-completion backend.
        return { selected: profile?.selected || 'openai', source: profile?.source || profile?.api || '' };
    }
}
