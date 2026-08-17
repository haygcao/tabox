import { test, expect } from 'crxbox';
import { buildSeed, seedStorage, tab } from './support/fixtures.mjs';

// Task Planner end-to-end smoke: real popup UI ↔ real SW handlers ↔ real
// storage, with only the AI network call stubbed (globalThis.TaboxAIClient is
// read lazily by chrome/task-planner.js, so replacing it in the live SW works).

const SEED = {
  collections: [{ uid: 'c1', name: 'Existing Collection' }],
};

// The panel is Pro-gated (premium: true) and the AI button is hidden unless
// chkTaboxAI is on. A fresh entitlement record with no ownerId plus a matching
// googleUser passes getProEntitlementForUser's ownership check with zero
// Worker calls (fresh refreshedAt → not stale → no refresh attempt).
function proSeed() {
  return {
    chkTaboxAI: true,
    premiumEntitlement: { entitled: true, refreshedAt: new Date().toISOString() },
    googleUser: { permissionId: 'e2e-user', emailAddress: 'e2e@example.com' },
  };
}

const PILLS = { pills: ['Plan a trip', 'Research a topic', 'Learn a new skill'] };
const TURN = {
  reply: 'I gathered a starter set for your Japan trip — flights and places to stay first.',
  collectionName: 'Japan Trip',
  groups: [
    {
      title: 'Flights',
      color: 'blue',
      tabs: [
        { title: 'Google Flights', url: 'https://www.google.com/travel/flights' },
        { title: 'Skyscanner', url: 'https://www.skyscanner.com' },
      ],
    },
    {
      title: 'Stay',
      color: 'green',
      tabs: [{ title: 'Booking.com', url: 'https://www.booking.com' }],
    },
  ],
};

const PILLS_2 = { pills: ['Plan a heist movie night', 'Learn pottery', 'Track a comet'] };

// Stub only the chat completion; pills vs turn calls are told apart by their
// response schema (PILLS_SCHEMA is the only one with a `pills` property).
// Pill calls rotate through batches so the reload button gets fresh ideas.
function stubChat(ext) {
  return ext.background.evaluate(({ pillBatches, turn }) => {
    let pillCalls = 0;
    globalThis.TaboxAIClient = {
      ...(globalThis.TaboxAIClient || {}),
      requestChatCompletion: async (messages, opts = {}) => {
        const schema = opts.responseConstraint || {};
        const isPills = !!(schema.properties && schema.properties.pills);
        if (!isPills) return JSON.stringify(turn);
        const batch = pillBatches[Math.min(pillCalls, pillBatches.length - 1)];
        pillCalls += 1;
        return JSON.stringify(batch);
      },
    };
  }, { pillBatches: [PILLS, PILLS_2], turn: TURN });
}

async function openPlanner(popup) {
  await popup.locator('.ai-button').click();
  await popup.locator('.ai-hero-card[data-tool-id="task-planner"]').click();
  await expect(popup.locator('.tp-root')).toBeVisible();
}

test('plan a trip end-to-end: greeting, pills, turn, remove, save', async ({ ext }) => {
  await seedStorage(ext, { ...buildSeed(SEED), ...proSeed() });
  await stubChat(ext);

  const popup = await ext.popup.open();
  await openPlanner(popup);

  // Greeting bubble + AI-generated suggestion pills (stubbed).
  await expect(popup.locator('.tp-bubble').first()).toContainText("I'm your Tabox planner");
  await expect(popup.locator('.tp-pill', { hasText: 'Plan a trip' })).toBeVisible();

  // The reload button spins up a fresh batch of ideas, avoiding the seen ones.
  await popup.locator('.tp-pills-refresh').click();
  await expect(popup.locator('.tp-pill', { hasText: 'Learn pottery' })).toBeVisible();
  await expect(popup.locator('.tp-pill', { hasText: 'Plan a trip' })).toHaveCount(0);

  // Sending a message lands the assistant reply and the grouped tab set.
  await popup.locator('.tp-input').fill('Plan a trip to Japan');
  await popup.locator('.tp-input').press('Enter');
  await expect(popup.locator('.tp-bubble', { hasText: 'starter set for your Japan trip' })).toBeVisible();
  await expect(popup.locator('.tp-group', { hasText: 'Flights' })).toBeVisible();
  await expect(popup.locator('.tp-group', { hasText: 'Stay' })).toBeVisible();
  await expect(popup.locator('.tp-tab')).toHaveCount(3);
  await expect(popup.locator('.tp-collection-name')).toHaveValue('Japan Trip');
  // Pills disappear after the first user message.
  await expect(popup.locator('.tp-pill')).toHaveCount(0);

  // Removing a tab updates the SW-owned session (and the count).
  await popup
    .locator('.tp-tab', { hasText: 'Skyscanner' })
    .locator('.tp-tab-remove')
    .click();
  await expect(popup.locator('.tp-tab')).toHaveCount(2);

  // Save: creates a real collection named by the AI, with the groups intact.
  await popup.locator('.tp-save-btn').click();
  await expect(popup.getByText('Japan Trip')).toBeVisible();

  const saved = await ext.background.evaluate(async () => {
    const { collections_index: index = {} } = await browser.storage.local.get('collections_index');
    const uid = Object.keys(index).find((k) => index[k].name === 'Japan Trip');
    if (!uid) return null;
    return (await browser.storage.local.get(`collection_${uid}`))[`collection_${uid}`] || null;
  });
  expect(saved).not.toBeNull();
  expect(saved.tabs).toHaveLength(2);
  expect(saved.chromeGroups.map((g) => g.title).sort()).toEqual(['Flights', 'Stay']);
  // Every tab must be wired to its group (groupUid drives rendering + counts).
  expect(saved.tabs.every((t) => !!t.groupUid)).toBe(true);

  // Post-save the chat does NOT reset: the transcript and tab set survive and
  // the session is linked to the saved collection — the footer flips to Update.
  await expect(popup.locator('.tp-bubble', { hasText: 'starter set for your Japan trip' })).toBeVisible();
  await expect(popup.locator('.tp-tab')).toHaveCount(2);
  await expect(popup.locator('.tp-save-btn')).toHaveText(/Update collection/);

  // Keep refining: another turn re-lands the full stubbed set (3 tabs)…
  await popup.locator('.tp-input').fill('Add back the flight comparison site');
  await popup.locator('.tp-input').press('Enter');
  await expect(popup.locator('.tp-tab')).toHaveCount(3);

  // …and Update collection rewrites the SAME collection in place: still
  // exactly one 'Japan Trip', now carrying the turn's 3 tabs.
  await popup.locator('.tp-save-btn').click();
  await expect
    .poll(() => ext.background.evaluate(async () => {
      const { collections_index: index = {} } = await browser.storage.local.get('collections_index');
      const uids = Object.keys(index).filter((k) => index[k].name === 'Japan Trip');
      if (uids.length !== 1) return { count: uids.length, tabCount: 0 };
      const rec = (await browser.storage.local.get(`collection_${uids[0]}`))[`collection_${uids[0]}`];
      return { count: 1, tabCount: rec ? rec.tabs.length : 0 };
    }))
    .toEqual({ count: 1, tabCount: 3 });

  const updated = await ext.background.evaluate(async () => {
    const { collections_index: index = {} } = await browser.storage.local.get('collections_index');
    const uid = Object.keys(index).find((k) => index[k].name === 'Japan Trip');
    return (await browser.storage.local.get(`collection_${uid}`))[`collection_${uid}`];
  });
  // Tabs match the stubbed turn (Flights ×2 then Stay ×1).
  expect(updated.tabs.map((t) => t.url)).toEqual([
    'https://www.google.com/travel/flights',
    'https://www.skyscanner.com',
    'https://www.booking.com',
  ]);
  // Same collection record, not a replacement: the uid of the first save survived.
  expect(updated.uid).toBe(saved.uid);
});

test('choose collection loads an existing collection into the planner and links it', async ({ ext }) => {
  const seeded = {
    uid: 'cg',
    name: 'Research Stack',
    tabs: [
      tab('alpha', 'Alpha', { groupUid: 'g1', groupId: 1 }),
      tab('beta', 'Beta', { groupUid: 'g1', groupId: 1 }),
      tab('gamma', 'Gamma'),
    ],
    chromeGroups: [{ id: 1, uid: 'g1', title: 'Sources', color: 'blue', collapsed: false }],
  };
  await seedStorage(ext, { ...buildSeed({ collections: [seeded, ...SEED.collections] }), ...proSeed() });
  await stubChat(ext);

  const popup = await ext.popup.open();
  await openPlanner(popup);
  await expect(popup.locator('.tp-bubble').first()).toContainText("I'm your Tabox planner");

  // Open the picker from the header icon and pick the seeded collection.
  await popup.locator('.tp-choose-btn').click();
  await expect(popup.locator('.tp-picker-title')).toHaveText('Choose a collection');
  await popup.locator('.tp-picker-row', { hasText: 'Research Stack' }).click();

  // Its groups/tabs land in the tabs panel: the real chrome group plus a
  // "More tabs" bucket for the ungrouped tab.
  await expect(popup.locator('.tp-group', { hasText: 'Sources' })).toBeVisible();
  await expect(popup.locator('.tp-group', { hasText: 'More tabs' })).toBeVisible();
  await expect(popup.locator('.tp-tab')).toHaveCount(3);
  await expect(popup.locator('.tp-collection-name')).toHaveValue('Research Stack');

  // The SW announces the load in the transcript and the session is linked.
  await expect(popup.locator('.tp-bubble', { hasText: 'Loaded "Research Stack"' })).toBeVisible();
  await expect(popup.locator('.tp-save-btn')).toHaveText(/Update collection/);
  // Linked sessions hide the picker triggers.
  await expect(popup.locator('.tp-choose-btn')).toHaveCount(0);
});

test('session survives popup close and reattaches', async ({ ext }) => {
  await seedStorage(ext, { ...buildSeed(SEED), ...proSeed() });
  await stubChat(ext);

  let popup = await ext.popup.open();
  await openPlanner(popup);
  await popup.locator('.tp-input').fill('Plan a trip to Japan');
  await popup.locator('.tp-input').press('Enter');
  await expect(popup.locator('.tp-group', { hasText: 'Flights' })).toBeVisible();

  // Close and reopen the popup: the SW-owned session must reattach with the
  // full transcript and tab set (the popup is a detachable observer).
  await popup.close();
  popup = await ext.popup.open();
  await openPlanner(popup);
  await expect(popup.locator('.tp-bubble', { hasText: 'Plan a trip to Japan' })).toBeVisible();
  await expect(popup.locator('.tp-group', { hasText: 'Flights' })).toBeVisible();
  await expect(popup.locator('.tp-tab')).toHaveCount(3);
});
