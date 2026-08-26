/**
 * Timeline-order Scene descriptors for the single shared Loom Archive.
 * Both modes belong here; their Loom readers differ, their Archive does not.
 */
export function listArchiveSceneDescriptors(timeline, store) {
    const scenes = [];
    for (let arcIndex = 0; arcIndex < (timeline?.arcIds || []).length; arcIndex += 1) {
        const arc = store?.arcs?.[timeline.arcIds[arcIndex]];
        for (const sceneId of arc?.sceneIds || []) {
            const scene = store?.scenes?.[sceneId];
            if (!scene || !['roleplay', 'story'].includes(scene.mode)) continue;
            scenes.push({
                id: scene.id,
                title: scene.title || 'Untitled Scene',
                mode: scene.mode,
                arcId: arc.id,
                arcTitle: arc.title || 'Untitled Arc',
                arcIndex,
                orderIndex: scenes.length,
            });
        }
    }
    return scenes;
}
