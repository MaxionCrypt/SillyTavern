/** True only for the editor mode (narrator drafts, Director reconciles). */
export function isEditorMode(scene) {
    return scene?.liveDirection?.mode === 'editor';
}
