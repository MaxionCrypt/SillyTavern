import { test, expect } from '@playwright/test';

const FIXTURE_SCENE = 'TEST - Inventory at 2:17 A.M.';
test.use({ channel: 'chrome' });

test.describe('Remodel Live Direction diagnostics', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/');
        const user = page.locator('#userList .userSelect:last-child');
        if (await user.isVisible({ timeout: 1500 }).catch(() => false)) await user.click();
        await page.waitForFunction('document.getElementById("preloader") === null', null, { timeout: 30_000 });
        await page.waitForFunction(() => Boolean(window.RemodelLiveDirectionDiagnostics), null, { timeout: 30_000 });
    });

    test('flight recorder is bounded and exportable', async ({ page }) => {
        const result = await page.evaluate(async () => {
            const diagnostics = await import('/scripts/extensions/third-party/SillyTavern-Remodel/live-direction-diagnostics.js');
            diagnostics.clearDirectionFlights();
            const id = diagnostics.beginDirectionFlight({ sceneId: 'fixture', action: 'Test action' });
            diagnostics.recordDirectionFlight('director.request.started', { promptMessages: 4 }, id);
            diagnostics.recordDirectionFlight('performer.request.started', { chatLength: 3 }, id);
            diagnostics.finishDirectionFlight('complete', { messageId: 4 }, id);
            return diagnostics.getDirectionFlight(id);
        });
        expect(result.status).toBe('complete');
        expect(result.counters['director.request.started']).toBe(1);
        expect(result.counters['performer.request.started']).toBe(1);
        expect(result.events.at(-1).type).toBe('flight.finished');
    });

    test('disposable fixture opens diagnostics without native Group Controls', async ({ page }) => {
        const opened = await page.evaluate(async (fixtureTitle) => {
            const context = (await import('/scripts/st-context.js')).getContext();
            const state = await import('/scripts/extensions/third-party/SillyTavern-Remodel/timeline-state.js');
            const groups = await import('/scripts/group-chats.js');
            const scene = Object.values(state.getTimelineStore().scenes || {}).find((item) => item.title === fixtureTitle);
            if (!scene?.linkedChat || scene.linkedChat.type !== 'group') return { skipped: true };
            state.setActiveScene(scene.id);
            await groups.openGroupById(context.groups.find((item) => String(item.id) === String(scene.linkedChat.groupId))?.id);
            await new Promise((resolve) => setTimeout(resolve, 500));
            context.chatMetadata.remodelScene = {
                timelineId: scene.timelineId,
                arcId: scene.arcId,
                sceneId: scene.id,
                mode: scene.mode,
                title: scene.title,
                linkedChat: scene.linkedChat,
                updatedAt: scene.updatedAt,
            };
            await context.eventSource.emit(context.eventTypes.CHAT_CHANGED, context.chatId);
            (await import('/script.js')).selectRightMenuWithAnimation(null);
            return { skipped: false };
        }, FIXTURE_SCENE);
        test.skip(opened.skipped, 'Disposable TEST timeline is not installed for this profile.');
        await expect(page.locator('#remodel-roleplay-root')).toBeVisible();
        // A recovered end-of-response run may correctly wait for Continue,
        // but it must not masquerade as a fresh generation after reload.
        await expect(page.locator('.remodel-rp-typing')).toHaveCount(0);
        await expect(page.locator('body')).not.toHaveClass(/remodel-roleplay-generating/);
        await page.locator('[data-remodel-live-diagnostics]').click();
        await expect(page.locator('#remodel-live-diagnostics-modal')).toBeVisible();
        await expect(page.locator('#right-nav-panel')).not.toBeVisible();
        await expect(page.locator('#rm_group_chats_block')).not.toBeVisible();
        await page.locator('[data-remodel-live-diagnostics-close]').click();
        await expect(page.locator('#remodel-live-diagnostics-modal')).toHaveCount(0);
    });
});
