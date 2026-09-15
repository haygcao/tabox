import { test, expect } from 'crxbox';
import { writeFileSync } from 'node:fs';
import { buildSeed, openFullPage, seedStorage } from './support/fixtures.mjs';

// Exercise the actual extension UI and background/session plumbing. Only the
// external AI provider is deterministic; no paid requests or personal data.
const collections = [
    { uid: 'research', name: 'Research', tabs: Array.from({ length: 42 }, (_, i) => ({ title: `Resource ${i + 1}`, url: `https://example.com/${i}` })) },
    ...Array.from({ length: 6 }, (_, i) => ({ uid: `c${i}`, name: `Collection ${i + 1}` })),
];

async function capture(page, state) {
    await page.screenshot({ animations: 'disabled', path: `output/playwright/ai-hub-${state}.png` });
    // Render-only fixture for checking these exact production DOM/CSS states
    // in Gecko, whose Playwright runner cannot load Chromium extensions.
    const html = await page.evaluate(() => {
        const root = document.documentElement.cloneNode(true);
        root.querySelectorAll('script').forEach(node => node.remove());
        const base = document.createElement('base');
        base.href = '/build-firefox/';
        root.querySelector('head').prepend(base);
        return '<!doctype html>' + root.outerHTML.replace(/chrome-extension:\/\/[^/]+\//g, '/build-firefox/');
    });
    writeFileSync(`output/playwright/ai-hub-${state}.html`, html);
}

test.beforeEach(async ({ ext }) => {
    await seedStorage(ext, { ...buildSeed({ collections }), chkTaboxAI: true, theme: 'dark',
        googleUser: { permissionId: 'hub-test', displayName: 'Test', emailAddress: 'test@example.com' },
        premiumEntitlement: { entitled: true, status: 'active', plan: 'monthly', refreshedAt: new Date().toISOString() },
    });
    await ext.background.evaluate(() => {
        globalThis.TaboxAIClient.aiAvailability = async () => 'available';
        globalThis.TaboxAIClient.createAISession = async () => ({ destroy() {} });
        globalThis.__hubSplitCalls = 0;
        globalThis.TaboxAIClient.promptForJSON = async () => { globalThis.__hubSplitCalls++; return { groups: [
            { name: 'Learning', tabIndices: Array.from({ length: 21 }, (_, i) => i + 1) },
            { name: 'Reference', tabIndices: Array.from({ length: 21 }, (_, i) => i + 22) },
        ] }; };
        globalThis.TaboxAIClient.requestChatCompletion = async (_messages, options) => JSON.stringify(options.responseConstraint.properties.tool
            ? { tool: 'auto-arrange-folders', uids: [], reply: 'Review your loose collections here.' }
            : { pills: ['Plan a Japan trip', 'Research design tools', 'Learn something new'] });
    });
});

for (const view of ['popup', 'fullpage']) {
    test(`${view}: suggestions continue across tool changes and reopen preserves the conversation`, async ({ ext }) => {
        const page = view === 'popup' ? await ext.popup.open() : await openFullPage(ext);
        await page.getByRole('button', { name: 'Tabox AI tools', exact: true }).click();
        const modal = page.getByRole('dialog', { name: 'Tabox AI Tools' });
        await expect(modal.getByLabel('Message Tabox AI')).toBeEnabled();
        await expect(modal.getByRole('button', { name: 'Plan something', exact: true })).toBeVisible();
        await expect(modal.locator('.ai-hub-start-prompts button')).toHaveCount(4);
        await expect(modal.locator('.ai-tools-list')).toHaveCount(0);
        await capture(page, `${view}-welcome`);

        await modal.getByRole('button', { name: 'Tidy my collections' }).click();
        await expect(modal.getByRole('button', { name: 'Arrange now', exact: true }).filter({ visible: true })).toBeVisible();
        await expect(modal.locator('.tp-bubble').filter({ hasText: 'Tidy my collections' })).toBeVisible();
        await expect(modal.getByLabel('Suggested next actions')).toHaveCount(0);
        await expect(modal.getByLabel('Message Tabox AI')).toBeEnabled();
        await expect(modal.locator('.tp-messages').getByRole('button', { name: 'Arrange now', exact: true }).filter({ visible: true })).toBeVisible();
        await expect(modal.locator('.ai-hub-review')).toHaveCount(0);
        await capture(page, `${view}-review`);

        await modal.getByRole('button', { name: 'Close', exact: true }).click();
        await page.getByRole('button', { name: 'Tabox AI tools', exact: true }).click();
        await expect(modal.locator('.tp-bubble').filter({ hasText: 'Tidy my collections' })).toBeVisible();
        await expect(modal.getByRole('button', { name: 'Arrange now', exact: true }).filter({ visible: true })).toBeVisible();
        await modal.getByRole('button', { name: 'More AI actions' }).click();
        await modal.locator('[data-tool-id="split-collection"]').click();
        await modal.getByRole('button', { name: 'Split', exact: true }).click();
        await expect(modal.getByLabel('Sub-collection 1 name')).toHaveValue('Learning');
        await expect(modal.getByLabel('Suggested next actions')).toHaveCount(0);
        await expect(modal.getByLabel('Message Tabox AI')).toBeEnabled();
        await capture(page, `${view}-split`);
        const inputBox = await modal.getByLabel('Message Tabox AI').boundingBox();
        const modalBox = await modal.boundingBox();
        expect(inputBox.y + inputBox.height).toBeLessThan(modalBox.y + modalBox.height);
        expect(inputBox.y).toBeGreaterThan(modalBox.y);
        // Neither suggestion click changed saved collections.
        expect(Object.keys(await ext.storage.local.get('collections_index'))).toHaveLength(7);
        const scans = await ext.background.evaluate(() => globalThis.__hubSplitCalls);
        await modal.getByRole('button', { name: 'Close', exact: true }).click();
        await page.getByRole('button', { name: 'Tabox AI tools', exact: true }).click();
        await expect(modal.getByLabel('Sub-collection 1 name')).toHaveValue('Learning');
        expect(await ext.background.evaluate(() => globalThis.__hubSplitCalls)).toBe(scans);
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.evaluate(() => new Promise(requestAnimationFrame));
        expect(await modal.evaluate(node => node.getAnimations({ subtree: true }).length)).toBe(0);
        await modal.getByRole('button', { name: 'New Chat', exact: true }).click();
        await expect(modal.locator('.tp-msg--user')).toHaveCount(0);
        await expect(modal.locator('.ai-hub-action-card')).toHaveCount(0);
        await expect(modal.locator('.ai-hub-start-prompts')).toBeVisible();
        await expect(modal.getByLabel('Message Tabox AI')).toBeEnabled();
        expect(Object.keys(await ext.storage.local.get('collections_index'))).toHaveLength(7);
        await modal.getByRole('button', { name: 'Close', exact: true }).click();
        await page.getByRole('button', { name: 'Tabox AI tools', exact: true }).click();
        await expect(modal.getByLabel('Message Tabox AI')).toBeEnabled();
        await expect(modal.locator('.tp-msg--user')).toHaveCount(0);
        await expect(modal.locator('.ai-hub-action-card')).toHaveCount(0);
    });
}

test('completed action keeps a compact result with undo and expandable details', async ({ ext }) => {
    const page = await ext.popup.open();
    await page.getByRole('button', { name: 'Tabox AI tools', exact: true }).click();
    const modal = page.getByRole('dialog', { name: 'Tabox AI Tools' });
    await expect(modal.getByLabel('Message Tabox AI')).toBeEnabled();
    await modal.getByRole('button', { name: 'Tidy my collections' }).click();
    await expect(modal.getByRole('button', { name: 'Arrange now', exact: true })).toBeVisible();
    await ext.storage.local.set({ aiTaskState: { taskId: 'result-style', type: 'auto-arrange', status: 'done', filed: 7, total: 7,
        summary: 'Organized 7 collections into 3 folders', undo: { task: 'auto-arrange', moves: [], createdFolderUids: [] } } });
    const result = modal.locator('.ai-hub-proposal--done');
    await expect(result).toBeVisible();
    await expect(result.getByRole('button', { name: 'Undo', exact: true })).toBeVisible();
    await expect(result.locator('.ai-hub-proposal-details')).toBeHidden();
    await capture(page, 'popup-completed');
    await result.getByRole('button', { name: 'View details' }).click();
    await expect(result.locator('.ai-hub-proposal-details')).toBeVisible();
});

for (const view of ['popup', 'fullpage']) {
    test(`${view}: planner side panel stays live beside chat`, async ({ ext }) => {
        const page = view === 'popup' ? await ext.popup.open() : await openFullPage(ext);
        await page.getByRole('button', { name: 'Tabox AI tools', exact: true }).click();
        const modal = page.getByRole('dialog', { name: 'Tabox AI Tools' });
        await expect(modal.getByLabel('Message Tabox AI')).toBeEnabled();
        await modal.getByRole('button', { name: 'Plan something', exact: true }).click();
        await expect(modal.getByRole('complementary', { name: 'Current collection' })).toHaveCount(0);
        const now = Date.now();
        const plan = { sessionId: 'live-plan', status: 'ready', collectionName: 'Japan trip', pills: [],
            hubAction: { id: 'plan-request', tool: 'task-planner', uids: [] },
            messages: [{ id: 'plan-request', role: 'user', content: 'Plan a Japan trip', ts: now }, { id: 'plan-answer', role: 'assistant', content: 'Here are some useful starting points.', ts: now }],
            groups: [{ uid: 'travel', title: 'Travel', color: 'blue', tabs: [{ uid: 'flights', title: 'Find flights', url: 'https://example.com/flights' }] }], createdAt: now, updatedAt: now };
        await ext.storage.local.set({ taskPlannerSession: plan });
        const sidebar = modal.getByRole('complementary', { name: 'Current collection' });
        await expect(sidebar.getByText('Find flights')).toBeVisible();
        await ext.storage.local.set({ taskPlannerSession: { ...plan, status: 'thinking', updatedAt: now + 1 } });
        await expect(sidebar).toBeVisible();
        await expect(modal.getByLabel('Message Tabox AI')).toBeDisabled();
        await ext.storage.local.set({ taskPlannerSession: { ...plan, groups: [{ ...plan.groups[0], tabs: [...plan.groups[0].tabs, { uid: 'hotels', title: 'Find hotels', url: 'https://example.com/hotels' }] }], updatedAt: now + 2 } });
        await expect(sidebar.getByText('Find hotels')).toBeVisible();
        await expect(modal.getByLabel('Message Tabox AI')).toBeEnabled();
        const sideBox = await sidebar.boundingBox();
        const chatBox = await modal.locator('.tp-chat').boundingBox();
        expect(sideBox.x).toBeGreaterThan(chatBox.x + chatBox.width - 1);
        const suggestions = modal.getByLabel('Suggested next actions');
        await expect(suggestions).toBeVisible();
        const suggestionsBox = await suggestions.boundingBox();
        const composerBox = await modal.locator('.tp-composer').boundingBox();
        expect(composerBox.y - suggestionsBox.y - suggestionsBox.height).toBeLessThan(20);
        await capture(page, `${view}-live-plan`);
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.evaluate(() => new Promise(requestAnimationFrame));
        expect(await sidebar.evaluate(node => node.getAnimations({ subtree: true }).length)).toBe(0);
    });
}

for (const view of ['popup', 'fullpage']) {
    test(`${view}: find-tab chat request lists matching saved tabs and opens one`, async ({ ext }) => {
        await ext.background.evaluate(() => {
            globalThis.TaboxAIClient.requestChatCompletion = async (_messages, options) => JSON.stringify(options.responseConstraint.properties.tool
                ? { tool: 'find-tab', uids: [], reply: 'I searched your collections.', query: 'resource 7' }
                : { pills: ['Plan a Japan trip', 'Research design tools', 'Learn something new'] });
        });
        const page = view === 'popup' ? await ext.popup.open() : await openFullPage(ext);
        await page.getByRole('button', { name: 'Tabox AI tools', exact: true }).click();
        const modal = page.getByRole('dialog', { name: 'Tabox AI Tools' });
        const input = modal.getByLabel('Message Tabox AI');
        await expect(input).toBeEnabled();
        await input.fill('find me the tab about resource 7');
        await input.press('Enter');
        await expect(modal.locator('.tp-bubble').filter({ hasText: 'I searched your collections.' })).toBeVisible();
        const results = modal.locator('.tp-tab-result');
        await expect(results.first()).toContainText('Resource 7');
        await expect(results.first()).toContainText('Research');
        // No tool card for a search answer.
        await expect(modal.locator('.ai-hub-action-card')).toHaveCount(0);
        await capture(page, `${view}-find-tab`);
        const before = (await ext.context.pages()).length;
        await results.first().click();
        await expect.poll(async () => (await ext.context.pages()).length).toBeGreaterThan(before);
        expect(Object.keys(await ext.storage.local.get('collections_index'))).toHaveLength(7);
    });
}
