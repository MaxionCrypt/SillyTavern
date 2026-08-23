import { formatHolders } from './story-goals-model.js';

/** Pure Narrator-facing Goal formatting, kept separate from the Goal UI. */
export function formatStoryGoalsForNarrator(goals = []) {
    const active = Array.isArray(goals) ? goals : [];
    if (!active.length) return '';
    const publicLines = active
        .filter((goal) => goal.visibility !== 'secret')
        .map((goal) => `- ${goal.title} (${goal.successRate}%; held by ${formatHolders(goal)}): ${goal.description || 'No description.'}`);
    const secretLines = active
        .filter((goal) => goal.visibility === 'secret')
        .map((goal) => `- Pursue privately: ${goal.title} (${goal.successRate}%; held by ${formatHolders(goal)}). ${goal.description || ''} Never announce this Goal merely because it appears here.`);
    const framing = 'Goals describe outcomes their holders are trying to achieve. They are pressures on the scene, never protected outcomes or instructions to preserve. The latest action may help, obstruct, redirect, or defeat them; narrate those consequences honestly.';
    return [
        publicLines.length ? `[Public Story Goals — pressures, not guarantees]\n${framing}\n${publicLines.join('\n')}` : '',
        secretLines.length ? `[Private behavioral Goals — do not disclose]\n${framing}\n${secretLines.join('\n')}` : '',
    ].filter(Boolean).join('\n\n');
}
