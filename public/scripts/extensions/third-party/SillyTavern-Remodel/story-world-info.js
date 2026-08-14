import {
    extension_prompt_roles,
    getMaxContextTokens,
    substituteParams,
} from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';
import { power_user } from '../../../power-user.js';
import { getTagKeyForEntity } from '../../../tags.js';
import { getCharaFilename } from '../../../utils.js';
import {
    DEFAULT_DEPTH,
    loadWorldInfo,
    selected_world_info,
    world_info,
    world_info_budget,
    world_info_budget_cap,
    world_info_case_sensitive,
    world_info_character_strategy,
    world_info_depth,
    world_info_include_names,
    world_info_insertion_strategy,
    world_info_match_whole_words,
    world_info_max_recursion_steps,
    world_info_min_activations,
    world_info_min_activations_depth_max,
    world_info_overflow_alert,
    world_info_position,
    world_info_recursive,
    world_info_use_group_scoring,
    world_names,
} from '../../../world-info.js';
import {
    getScriptsByType,
    regex_placement,
    runRegexScript,
    SCRIPT_TYPES,
    substitute_find_regex,
} from '../../regex/engine.js';
import { getContext } from '../../../st-context.js';

const MAX_SCAN_DEPTH = 1000;

export function getStoryLorebookNames() {
    return Array.isArray(world_names) ? [...world_names] : [];
}

export function getStoryWorldInfoMaxContext() {
    try {
        return Math.max(1, Number(getMaxContextTokens()) || Number(getContext().maxContext) || 8192);
    } catch {
        return Math.max(1, Number(getContext().maxContext) || 8192);
    }
}

export function normalizeStoryWorldInfoState(value) {
    const source = value && typeof value === 'object' ? value : {};
    return {
        generationIndex: Math.max(0, Number(source.generationIndex) || 0),
        sticky: normalizeEffectMap(source.sticky),
        cooldown: normalizeEffectMap(source.cooldown),
    };
}

export function advanceStoryWorldInfoState(pendingState) {
    const state = normalizeStoryWorldInfoState(pendingState);
    state.generationIndex += 1;
    pruneEffects(state);
    return state;
}

export async function resolveStoryWorldInfo({
    doc,
    mode = 'continue',
    beat = '',
    maxContext = getStoryWorldInfoMaxContext(),
    dryRun = true,
    timelineLorebook = null,
} = {}) {
    const context = getContext();
    const diagnostics = [];
    const notes = ['Native chat-scoped external World Info activations are intentionally excluded from Story documents.'];
    const characterId = doc?.boundCharacterId == null ? null : Number(doc.boundCharacterId);
    const character = Number.isInteger(characterId) ? context.characters?.[characterId] : null;
    const characterName = character?.name || '';
    const userName = context.name1 || 'User';
    const macroOptions = {
        name1Override: userName,
        name2Override: characterName || 'Character',
        replaceCharacterCard: false,
        dynamicMacros: {
            charPrompt: character?.data?.system_prompt || '',
            description: character?.description || '',
            personality: character?.personality || '',
            scenario: character?.scenario || '',
            persona: power_user.persona_description || '',
            mesExamplesRaw: character?.mes_example || '',
            charDepthPrompt: character?.data?.extensions?.depth_prompt?.prompt || '',
            creatorNotes: character?.data?.creator_notes || '',
        },
    };
    const state = normalizeStoryWorldInfoState(doc?.worldInfoState);
    pruneEffects(state);

    if (!character) diagnostics.push('The Story document has no valid bound character; character-linked lorebooks and filters were skipped.');

    const { entries, books } = await loadStoryEntries({ doc, character, characterId, diagnostics, timelineLorebook });
    const corpus = buildScanCorpus(doc, beat);
    const globalScanData = buildGlobalScanData({ doc, character, macroOptions });
    const trigger = mode === 'regenerate' ? 'regenerate' : mode === 'continue' ? 'continue' : 'normal';
    const seedBase = `${doc?.id || 'story'}:${state.generationIndex}`;
    const activated = new Map();
    const failedProbability = new Set();
    let recursionText = [];
    let scanDepth = clamp(Number(world_info_depth) || 0, 0, MAX_SCAN_DEPTH);
    const minDepthLimit = clamp(Number(world_info_min_activations_depth_max) || corpus.length || scanDepth, scanDepth, MAX_SCAN_DEPTH);
    const maxPasses = Number(world_info_max_recursion_steps) > 0
        ? Number(world_info_max_recursion_steps)
        : Math.max(1, entries.length + minDepthLimit + 1);
    let pass = 0;
    let recursion = false;

    while (pass < maxPasses) {
        pass += 1;
        const candidates = [];
        for (const entry of entries) {
            const key = entryKey(entry);
            if (activated.has(key) || failedProbability.has(key) || entry.disable === true) continue;
            if (Array.isArray(entry.triggers) && entry.triggers.length && !entry.triggers.includes(trigger)) continue;
            if (!passesCharacterFilter(entry, characterId, character, context)) continue;
            if (isEffectActive(state.cooldown, entry, state.generationIndex) && !isEffectActive(state.sticky, entry, state.generationIndex)) continue;
            if (Number(entry.delay) > state.generationIndex) continue;
            if (recursion && entry.excludeRecursion) continue;
            if (!recursion && entry.delayUntilRecursion) continue;
            if (recursion && Number(entry.delayUntilRecursion) > pass - 1) continue;

            const sticky = isEffectActive(state.sticky, entry, state.generationIndex);
            const match = matchEntry(entry, {
                corpus,
                recursionText,
                scanDepth,
                recursion,
                globalScanData,
                macroOptions,
            });
            if (!sticky && !match.active) continue;

            const probability = entry.useProbability === false ? 100 : Number(entry.probability ?? 100);
            if (!sticky && probability < 100 && deterministicUnit(`${seedBase}:probability:${key}`) * 100 >= probability) {
                failedProbability.add(key);
                continue;
            }
            candidates.push({ entry, score: sticky ? Number.MAX_SAFE_INTEGER : match.score });
        }

        const selected = selectInclusionGroups(candidates, seedBase, pass);
        let added = 0;
        for (const candidate of selected.sort((a, b) => sortEntries(a.entry, b.entry))) {
            const key = entryKey(candidate.entry);
            if (activated.has(key)) continue;
            activated.set(key, candidate.entry);
            if (!candidate.entry.preventRecursion && candidate.entry.content) recursionText.push(candidate.entry.content);
            added += 1;
        }

        if (added > 0 && world_info_recursive) {
            recursion = true;
            continue;
        }
        if (activated.size < Number(world_info_min_activations) && scanDepth < minDepthLimit) {
            scanDepth += 1;
            recursion = false;
            continue;
        }
        break;
    }

    const budget = calculateBudget(maxContext);
    const budgeted = [];
    let usedTokens = 0;
    let overflowed = false;
    for (const entry of [...activated.values()].sort(sortEntries)) {
        const content = resolveEntryContent(entry, macroOptions, character);
        if (!content) continue;
        const tokens = await countTokens(content);
        if (!entry.ignoreBudget && usedTokens + tokens > budget) {
            diagnostics.push(`World Info budget omitted ${entry.world} #${entry.uid}${world_info_overflow_alert ? ' (overflow alert enabled)' : ''}.`);
            overflowed = true;
            continue;
        }
        if (!entry.ignoreBudget) usedTokens += tokens;
        budgeted.push({ ...entry, resolvedContent: content });
    }
    if (overflowed && world_info_overflow_alert && !dryRun) {
        globalThis.toastr?.warning?.(`Story World Info budget reached after ${budgeted.length} entries.`, 'World Info');
    }

    const result = placeEntries(budgeted);
    const pendingState = applyTimedEffects(state, budgeted);
    if (entries.some((entry) => Number(entry.delay) > 0 || Number(entry.sticky) > 0 || Number(entry.cooldown) > 0)) {
        notes.push(`Timed lore rules are evaluated against Story generation ${state.generationIndex + 1}; ${dryRun ? 'preview did not advance the counter' : 'state will advance only after prose is inserted'}.`);
    }
    if (world_info_include_names) notes.push('“Include names” is not applied because Story manuscript paragraphs do not have chat speaker labels.');

    return {
        ...result,
        books,
        activatedEntries: budgeted.map((entry) => ({
            world: entry.world,
            uid: entry.uid,
            title: entry.comment || entry.name || `Entry ${entry.uid}`,
            position: Number(entry.position ?? world_info_position.before),
            destination: describeEntryDestination(entry),
        })),
        diagnostics: unique(diagnostics),
        notes: unique(notes),
        pendingState,
        macroOptions,
        budget: { used: usedTokens, maximum: budget },
    };
}

async function loadStoryEntries({ doc, character, characterId, diagnostics, timelineLorebook = null }) {
    const globalBooks = unique((selected_world_info || []).filter(Boolean));
    // A Timeline-level book applies to every Scene in that Timeline; the
    // document's own book is narrower still. Both sit ahead of global and
    // character books, since the more specific binding should win a budget
    // contest.
    const documentBooks = [timelineLorebook, doc?.lorebookName]
        .filter(Boolean)
        .map(String);
    // No persona lorebook in a Story document. A story has no persona — the
    // user is the author, not someone being played — so a book attached to the
    // active persona has no business steering the prose. It was also the only
    // one of these bindings with no visible control anywhere, which made it
    // appear as lore from nowhere.
    const personaBooks = [];
    const characterBooks = [];
    if (character?.data?.extensions?.world) characterBooks.push(String(character.data.extensions.world));
    if (characterId != null) {
        const fileName = getCharaFilename(characterId);
        const extra = world_info.charLore?.find((item) => item?.name === fileName)?.extraBooks;
        if (Array.isArray(extra)) characterBooks.push(...extra.filter(Boolean).map(String));
    }

    const seen = new Set(globalBooks);
    const uniqueDocument = documentBooks.filter((name) => !seen.has(name) && seen.add(name));
    const uniquePersona = personaBooks.filter((name) => !seen.has(name) && seen.add(name));
    const uniqueCharacter = unique(characterBooks).filter((name) => !seen.has(name) && seen.add(name));
    const globalEntries = await loadBooks(globalBooks, 'global', diagnostics);
    const characterEntries = await loadBooks(uniqueCharacter, 'character', diagnostics);
    const documentEntries = await loadBooks(uniqueDocument, 'document', diagnostics);
    const personaEntries = await loadBooks(uniquePersona, 'persona', diagnostics);
    let remainder;
    switch (Number(world_info_character_strategy)) {
        case world_info_insertion_strategy.global_first:
            remainder = [...globalEntries.sort(sortEntries), ...characterEntries.sort(sortEntries)];
            break;
        case world_info_insertion_strategy.evenly:
            remainder = [...globalEntries, ...characterEntries].sort(sortEntries);
            break;
        case world_info_insertion_strategy.character_first:
        default:
            remainder = [...characterEntries.sort(sortEntries), ...globalEntries.sort(sortEntries)];
            break;
    }
    return {
        entries: [...documentEntries.sort(sortEntries), ...personaEntries.sort(sortEntries), ...remainder],
        books: {
            document: uniqueDocument,
            persona: uniquePersona,
            character: uniqueCharacter,
            global: globalBooks,
        },
    };
}

async function loadBooks(names, source, diagnostics) {
    const entries = [];
    for (const name of names) {
        try {
            const data = await loadWorldInfo(name);
            if (!data?.entries) {
                diagnostics.push(`Lorebook “${name}” is unavailable.`);
                continue;
            }
            for (const [uid, raw] of Object.entries(data.entries)) {
                const [decorators, stripped] = parseStoryDecorators(String(raw?.content || ''));
                entries.push({ ...structuredClone(raw), uid: raw.uid ?? Number(uid), world: name, source, content: stripped, decorators, hash: hashString(JSON.stringify(raw)) });
            }
        } catch (error) {
            diagnostics.push(`Lorebook “${name}” could not be loaded: ${String(error?.message || error)}`);
        }
    }
    return entries;
}

function parseStoryDecorators(content) {
    if (!content.startsWith('@@')) return [[], content];
    const known = ['@@activate', '@@dont_activate'];
    const lines = content.split('\n');
    const decorators = [];
    let fallback = false;
    let bodyStart = lines.length;
    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        if (!line.startsWith('@@')) {
            bodyStart = index;
            break;
        }
        if (line.startsWith('@@@') && !fallback) continue;
        const normalized = line.startsWith('@@@') ? line.slice(1) : line;
        if (known.some((decorator) => normalized.startsWith(decorator))) {
            decorators.push(normalized);
            fallback = false;
        } else {
            fallback = true;
        }
    }
    return [decorators, lines.slice(bodyStart).join('\n')];
}

function buildScanCorpus(doc, beat) {
    const paragraphs = (value) => String(value || '').split(/\n\s*\n|\r?\n/).map((part) => part.trim()).filter(Boolean).reverse();
    return [
        ...(String(beat || '').trim() ? [String(beat).trim()] : []),
        ...paragraphs(doc?.body),
        ...paragraphs(doc?.priorText),
        ...(doc?.scanGuidanceForLore && String(doc?.guidance || '').trim() ? [String(doc.guidance).trim()] : []),
    ].slice(0, MAX_SCAN_DEPTH);
}

function buildGlobalScanData({ character, macroOptions }) {
    const resolve = (value) => substituteParams(String(value || ''), macroOptions);
    return {
        // Empty for the same reason the persona lorebook is skipped: a Story
        // document has no persona, so an entry set to "match persona
        // description" has nothing legitimate to match against here. Leaving it
        // populated would quietly activate entries on text that is not part of
        // the story at all.
        personaDescription: '',
        characterDescription: resolve(character?.description),
        characterPersonality: resolve(character?.personality),
        characterDepthPrompt: resolve(character?.data?.extensions?.depth_prompt?.prompt),
        scenario: resolve(character?.scenario),
        creatorNotes: resolve(character?.data?.creator_notes),
    };
}

function matchEntry(entry, { corpus, recursionText, scanDepth, recursion, globalScanData, macroOptions }) {
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

function parseRegex(value) {
    const match = String(value).match(/^\/([\s\S]+)\/([dgimsuvy]*)$/);
    if (!match) return null;
    try { return new RegExp(match[1], match[2]); } catch { return null; }
}

function passesCharacterFilter(entry, characterId, character, context) {
    const filter = entry.characterFilter;
    if (!filter) return true;
    const hasNames = Array.isArray(filter.names) && filter.names.length > 0;
    const hasTags = Array.isArray(filter.tags) && filter.tags.length > 0;
    if (!hasNames && !hasTags) return true;
    if (!character) return Boolean(filter.isExclude);
    const fileName = getCharaFilename(characterId);
    if (hasNames) {
        const included = filter.names.includes(fileName);
        if (filter.isExclude ? included : !included) return false;
    }
    const tagKey = getTagKeyForEntity(characterId);
    const mappedTags = tagKey && Array.isArray(context.tagMap?.[tagKey]) ? context.tagMap[tagKey] : [];
    if (hasTags) {
        const included = mappedTags.some((tag) => filter.tags.includes(tag));
        if (filter.isExclude ? included : !included) return false;
    }
    return true;
}

function selectInclusionGroups(candidates, seedBase, pass) {
    const groups = new Map();
    for (const candidate of candidates) {
        const entryGroups = String(candidate.entry.group || '').split(/,\s*/).map((value) => value.trim()).filter(Boolean);
        for (const group of entryGroups) {
            if (!groups.has(group)) groups.set(group, []);
            groups.get(group).push(candidate);
        }
    }
    const eligible = new Set(candidates);
    for (const [group, members] of groups) {
        const activeMembers = members.filter((item) => eligible.has(item));
        if (activeMembers.length <= 1) continue;
        const sticky = activeMembers.filter((item) => item.score === Number.MAX_SAFE_INTEGER);
        if (sticky.length) {
            for (const item of activeMembers) if (!sticky.includes(item)) eligible.delete(item);
            continue;
        }
        const overrides = activeMembers.filter((item) => item.entry.groupOverride).sort((a, b) => sortEntries(a.entry, b.entry));
        if (overrides.length) {
            for (const item of activeMembers) if (item !== overrides[0]) eligible.delete(item);
            continue;
        }
        let pool = activeMembers;
        if (world_info_use_group_scoring || activeMembers.some((item) => item.entry.useGroupScoring)) {
            const best = Math.max(...activeMembers.map((item) => item.score));
            pool = activeMembers.filter((item) => item.score === best);
        }
        const total = pool.reduce((sum, item) => sum + Math.max(1, Number(item.entry.groupWeight) || 100), 0);
        let roll = deterministicUnit(`${seedBase}:group:${group}:${pass}`) * total;
        let winner = pool[pool.length - 1];
        for (const item of pool) {
            roll -= Math.max(1, Number(item.entry.groupWeight) || 100);
            if (roll <= 0) { winner = item; break; }
        }
        for (const item of activeMembers) if (item !== winner) eligible.delete(item);
    }
    return candidates.filter((candidate) => eligible.has(candidate));
}

function calculateBudget(maxContext) {
    let budget = Math.round((Number(world_info_budget) || 0) * Math.max(1, Number(maxContext) || 1) / 100) || 1;
    if (Number(world_info_budget_cap) > 0) budget = Math.min(budget, Number(world_info_budget_cap));
    return budget;
}

async function countTokens(value) {
    try { return Math.max(1, Number(await getContext().getTokenCountAsync(String(value))) || 1); }
    catch { return Math.max(1, Math.ceil(String(value).length / 4)); }
}

function resolveEntryContent(entry, macroOptions, character) {
    const depth = Number(entry.position) === world_info_position.atDepth ? Number(entry.depth ?? DEFAULT_DEPTH) : null;
    let content = getStoryRegexedString(String(entry.content || ''), {
        character,
        macroOptions,
        placement: regex_placement.WORLD_INFO,
        depth,
        isMarkdown: false,
        isPrompt: true,
    });
    content = substituteParams(String(content || ''), macroOptions);
    return content.trim();
}

function getStoryRegexedString(rawString, { character, macroOptions, placement, isMarkdown, isPrompt, depth }) {
    if (!rawString || placement === undefined || extension_settings.disabledExtensions?.includes('regex')) return rawString;
    const scripts = [
        ...getScriptsByType(SCRIPT_TYPES.GLOBAL, { allowedOnly: true }),
        ...getScriptsByType(SCRIPT_TYPES.PRESET, { allowedOnly: true }),
    ];
    const scopedAllowed = extension_settings.character_allowed_regex?.includes(character?.avatar);
    const scopedScripts = character?.data?.extensions?.regex_scripts;
    if (scopedAllowed && Array.isArray(scopedScripts)) scripts.push(...scopedScripts);

    let value = rawString;
    for (const sourceScript of scripts) {
        const appliesToSurface = (sourceScript.markdownOnly && isMarkdown)
            || (sourceScript.promptOnly && isPrompt)
            || (!sourceScript.markdownOnly && !sourceScript.promptOnly && !isMarkdown && !isPrompt);
        if (!appliesToSurface || !sourceScript.placement?.includes(placement)) continue;
        if (typeof depth === 'number') {
            if (!isNaN(sourceScript.minDepth) && sourceScript.minDepth !== null && sourceScript.minDepth >= -1 && depth < sourceScript.minDepth) continue;
            if (!isNaN(sourceScript.maxDepth) && sourceScript.maxDepth !== null && sourceScript.maxDepth >= 0 && depth > sourceScript.maxDepth) continue;
        }
        const script = prepareStoryRegexScript(sourceScript, macroOptions);
        value = runRegexScript(script, value, { characterOverride: macroOptions.name2Override });
    }
    return value;
}

function prepareStoryRegexScript(sourceScript, macroOptions) {
    const script = structuredClone(sourceScript);
    if (Number(script.substituteRegex) !== substitute_find_regex.NONE) {
        const postProcessFn = Number(script.substituteRegex) === substitute_find_regex.ESCAPED
            ? escapeRegexMacro
            : (value) => value;
        script.findRegex = substituteParams(String(script.findRegex || ''), { ...macroOptions, postProcessFn });
        script.substituteRegex = substitute_find_regex.NONE;
    }
    script.replaceString = substituteParams(String(script.replaceString || ''), macroOptions);
    script.trimStrings = Array.isArray(script.trimStrings)
        ? script.trimStrings.map((value) => substituteParams(String(value), macroOptions))
        : [];
    return script;
}

function escapeRegexMacro(value) {
    return String(value || '').replace(/[\n\r\t\v\f\0.^$*+?{}[\]\\/|()]/gs, (character) => {
        const escapes = { '\n': '\\n', '\r': '\\r', '\t': '\\t', '\v': '\\v', '\f': '\\f', '\0': '\\0' };
        return escapes[character] || `\\${character}`;
    });
}

function placeEntries(entries) {
    const before = [], after = [], examplesBefore = [], examplesAfter = [], authorNoteBefore = [], authorNoteAfter = [];
    const depthGroups = new Map();
    const outlets = {};
    for (const entry of [...entries].sort(sortEntries)) {
        const content = entry.resolvedContent;
        switch (Number(entry.position ?? world_info_position.before)) {
            case world_info_position.after: after.unshift(content); break;
            case world_info_position.EMTop: examplesBefore.unshift(content); break;
            case world_info_position.EMBottom: examplesAfter.unshift(content); break;
            case world_info_position.ANTop: authorNoteBefore.unshift(content); break;
            case world_info_position.ANBottom: authorNoteAfter.unshift(content); break;
            case world_info_position.atDepth: {
                const role = mapPromptRole(entry.role);
                const key = `${Number(entry.depth ?? DEFAULT_DEPTH)}:${role}`;
                const group = depthGroups.get(key) || { depth: Number(entry.depth ?? DEFAULT_DEPTH), role, entries: [] };
                group.entries.unshift(content);
                depthGroups.set(key, group);
                break;
            }
            case world_info_position.outlet: {
                const name = String(entry.outletName || '').trim();
                if (name) (outlets[name] ??= []).push(content);
                break;
            }
            case world_info_position.before:
            default: before.unshift(content); break;
        }
    }
    const depthMessages = [...depthGroups.values()]
        .sort((a, b) => b.depth - a.depth)
        .map((group) => ({ role: group.role, content: group.entries.join('\n'), depth: group.depth }));
    return {
        worldInfoBefore: before.join('\n'),
        worldInfoAfter: after.join('\n'),
        worldInfoExamples: [...examplesBefore, ...examplesAfter].join('\n'),
        worldInfoDepth: { messages: depthMessages },
        authorNoteBefore: authorNoteBefore.join('\n'),
        authorNoteAfter: authorNoteAfter.join('\n'),
        outlets,
    };
}

function applyTimedEffects(state, entries) {
    const pending = normalizeStoryWorldInfoState(state);
    const turn = pending.generationIndex;
    for (const entry of entries) {
        const key = entryKey(entry);
        const sticky = Math.max(0, Number(entry.sticky) || 0);
        const cooldown = Math.max(0, Number(entry.cooldown) || 0);
        if (sticky) pending.sticky[key] = { hash: entry.hash, end: turn + sticky };
        if (cooldown) pending.cooldown[key] = { hash: entry.hash, end: turn + sticky + cooldown };
    }
    return pending;
}

function normalizeEffectMap(value) {
    const output = {};
    if (!value || typeof value !== 'object') return output;
    for (const [key, effect] of Object.entries(value)) {
        if (!effect || typeof effect !== 'object') continue;
        output[key] = { hash: Number(effect.hash) || 0, end: Math.max(0, Number(effect.end) || 0) };
    }
    return output;
}

function pruneEffects(state) {
    for (const type of ['sticky', 'cooldown']) {
        for (const [key, effect] of Object.entries(state[type])) {
            if (effect.end <= state.generationIndex) delete state[type][key];
        }
    }
}

function isEffectActive(map, entry, turn) {
    const effect = map?.[entryKey(entry)];
    return Boolean(effect && effect.hash === entry.hash && effect.end > turn);
}

function mapPromptRole(role) {
    if (Number(role) === extension_prompt_roles.USER) return 'user';
    if (Number(role) === extension_prompt_roles.ASSISTANT) return 'assistant';
    return 'system';
}

function describeEntryDestination(entry) {
    switch (Number(entry.position ?? world_info_position.before)) {
        case world_info_position.after: return 'World Info after';
        case world_info_position.EMTop: return 'Examples top';
        case world_info_position.EMBottom: return 'Examples bottom';
        case world_info_position.ANTop: return 'Author Guidance top';
        case world_info_position.ANBottom: return 'Author Guidance bottom';
        case world_info_position.atDepth: return `Depth ${Number(entry.depth ?? DEFAULT_DEPTH)} · ${mapPromptRole(entry.role)}`;
        case world_info_position.outlet: return `Outlet ${String(entry.outletName || '(unnamed)')}`;
        case world_info_position.before:
        default: return 'World Info before';
    }
}

function entryKey(entry) { return `${entry.world}.${entry.uid}`; }
function sortEntries(a, b) { return (Number(b.order) || 0) - (Number(a.order) || 0); }
function clamp(value, minimum, maximum) { return Math.min(maximum, Math.max(minimum, value)); }
function unique(values) { return [...new Set((values || []).filter(Boolean))]; }
function escapeRegex(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function hashString(value) {
    let hash = 2166136261;
    for (let i = 0; i < String(value).length; i++) {
        hash ^= String(value).charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

function deterministicUnit(value) {
    return hashString(value) / 0x100000000;
}
