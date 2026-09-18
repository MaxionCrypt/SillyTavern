// Native-faithful World Info keyword matcher.
//
// Extracted verbatim from story-world-info.js so both Story World Info
// activation and Living Lore retrieval share ONE matcher rather than each
// reimplementing native selective-logic scoring. matchEntry decides whether an
// entry activates against a scan corpus and returns a match score; it honours
// native primary key (OR), secondary keys per selectiveLogic
// (0=AND_ANY, 1=NOT_ALL, 2=NOT_ANY, 3=AND_ALL), regex keys, case sensitivity,
// and whole-word matching. It returns { active:false, score:0 } unless a
// positive scanDepth is supplied (it scans corpus.slice(0, depth)).

import { substituteParams } from '../../../../script.js';
import { world_info_case_sensitive, world_info_match_whole_words } from '../../../world-info.js';

export const MAX_SCAN_DEPTH = 1000;

export function clamp(value, minimum, maximum) { return Math.min(maximum, Math.max(minimum, value)); }

function escapeRegex(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function parseRegex(value) {
    const match = String(value).match(/^\/([\s\S]+)\/([dgimsuvy]*)$/);
    if (!match) return null;
    try { return new RegExp(match[1], match[2]); } catch { return null; }
}

function matchesKey(haystack, needle, entry) {
    if (!needle) return false;
    const parsed = parseRegex(needle);
    if (parsed) return parsed.test(haystack);
    const caseSensitive = entry.caseSensitive ?? world_info_case_sensitive;
    const source = caseSensitive ? haystack : haystack.toLowerCase();
    const target = caseSensitive ? needle : needle.toLowerCase();
    if (!(entry.matchWholeWords ?? world_info_match_whole_words)) return source.includes(target);
    if (/\s/.test(target)) return source.includes(target);
    return new RegExp(`(?:^|\\W)${escapeRegex(target)}(?:$|\\W)`, caseSensitive ? '' : 'i').test(haystack);
}

export function matchEntry(entry, { corpus, recursionText, scanDepth, recursion, globalScanData, macroOptions }) {
    if (entry.decorators?.includes('@@dont_activate')) return { active: false, score: 0 };
    if (entry.decorators?.includes('@@activate') || entry.constant) return { active: true, score: Number.MAX_SAFE_INTEGER };
    const depth = clamp(Number(entry.scanDepth ?? scanDepth) || 0, 0, MAX_SCAN_DEPTH);
    if (depth <= 0) return { active: false, score: 0 };
    const chunks = corpus.slice(0, depth);
    if (recursion && recursionText.length) chunks.push(...recursionText);
    if (entry.matchPersonaDescription && globalScanData.personaDescription) chunks.push(globalScanData.personaDescription);
    if (entry.matchCharacterDescription && globalScanData.characterDescription) chunks.push(globalScanData.characterDescription);
    if (entry.matchCharacterPersonality && globalScanData.characterPersonality) chunks.push(globalScanData.characterPersonality);
    if (entry.matchCharacterDepthPrompt && globalScanData.characterDepthPrompt) chunks.push(globalScanData.characterDepthPrompt);
    if (entry.matchScenario && globalScanData.scenario) chunks.push(globalScanData.scenario);
    if (entry.matchCreatorNotes && globalScanData.creatorNotes) chunks.push(globalScanData.creatorNotes);
    const haystack = chunks.join('\n');
    const primary = Array.isArray(entry.key) ? entry.key.filter(Boolean) : [];
    if (!primary.length) return { active: false, score: 0 };
    const primaryMatches = primary.filter((key) => matchesKey(haystack, substituteParams(String(key), macroOptions), entry));
    if (!primaryMatches.length) return { active: false, score: 0 };
    const secondary = Array.isArray(entry.keysecondary) ? entry.keysecondary.filter(Boolean) : [];
    if (!secondary.length) return { active: true, score: primaryMatches.length };
    const secondaryMatches = secondary.filter((key) => matchesKey(haystack, substituteParams(String(key), macroOptions), entry));
    const logic = Number(entry.selectiveLogic ?? 0);
    const active = logic === 1
        ? secondaryMatches.length !== secondary.length
        : logic === 2
            ? secondaryMatches.length === 0
            : logic === 3
                ? secondaryMatches.length === secondary.length
                : secondaryMatches.length > 0;
    const score = logic === 0 || logic === 3
        ? primaryMatches.length + secondaryMatches.length
        : primaryMatches.length;
    return { active, score };
}
