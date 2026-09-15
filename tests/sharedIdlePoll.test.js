// Cost control: a signed-in user with NO local shared folders and NO pending
// invites must not hit the Worker every sync tick (the 1-minute no-push alarm
// plus the popup's 8s nudge were ~1.3M requests/day account-wide). Such an
// idle client does the full list + invites check at most once per hour; a
// forced sync (push tickle, fresh login) bypasses the gate.
import { browser } from '../static/globals';
import {
  syncSharedFolders,
  SHARED_PENDING_INVITES_KEY,
  SHARED_IDLE_POLL_KEY,
  SHARED_IDLE_POLL_INTERVAL_MS,
} from '../chrome/shared-folders';

jest.mock('../chrome/background-utils', () => ({
  ...jest.requireActual('../chrome/background-utils'),
  getAuthToken: jest.fn().mockResolvedValue('tok'),
}));

function installStorageMock() {
  const store = {};
  browser.storage.local.get = jest.fn(async (keys) => {
    if (keys === undefined || keys === null) return { ...store };
    const names = Array.isArray(keys) ? keys : [keys];
    return names.reduce((acc, k) => ({ ...acc, [k]: store[k] }), {});
  });
  browser.storage.local.set = jest.fn(async (obj) => { Object.assign(store, obj); });
  browser.storage.local.remove = jest.fn(async (keys) => {
    (Array.isArray(keys) ? keys : [keys]).forEach((k) => { delete store[k]; });
  });
  return store;
}

const okJson = (body) => ({ ok: true, status: 200, json: async () => body });

beforeEach(async () => {
  jest.clearAllMocks();
  global.fetch = jest.fn(async (url) => {
    if (url.includes('/shared/invites')) return okJson({ invites: [] });
    if (url.endsWith('/shared/folders')) return okJson({ folders: [] });
    throw new Error(`unexpected fetch ${url}`);
  });
  installStorageMock();
  await browser.storage.local.set({
    googleUser: { emailAddress: 'me@x.com', permissionId: 'g-me' },
    folders_index: {},
    collections_index: {},
  });
});

test('idle client: first cycle does the list + invites check and stamps the idle key', async () => {
  const res = await syncSharedFolders();
  expect(res.ok).toBe(true);
  const urls = global.fetch.mock.calls.map(([u]) => u);
  expect(urls.some((u) => u.endsWith('/shared/folders'))).toBe(true);
  expect(urls.some((u) => u.includes('/shared/invites'))).toBe(true);
  const { [SHARED_IDLE_POLL_KEY]: idle } = await browser.storage.local.get(SHARED_IDLE_POLL_KEY);
  expect(typeof idle.lastAt).toBe('number');
});

test('idle client: cycles within the hour make ZERO network calls', async () => {
  await syncSharedFolders();
  global.fetch.mockClear();
  await syncSharedFolders();
  await syncSharedFolders();
  expect(global.fetch).not.toHaveBeenCalled();
});

test('idle client: once the hour elapses the full check runs again', async () => {
  await browser.storage.local.set({
    [SHARED_IDLE_POLL_KEY]: { lastAt: Date.now() - SHARED_IDLE_POLL_INTERVAL_MS - 1 },
  });
  await syncSharedFolders();
  expect(global.fetch).toHaveBeenCalled();
});

test('force: true bypasses the idle gate (push tickle / login)', async () => {
  await browser.storage.local.set({ [SHARED_IDLE_POLL_KEY]: { lastAt: Date.now() } });
  await syncSharedFolders({ force: true });
  expect(global.fetch).toHaveBeenCalled();
});

test('pending invites in storage keep the per-tick poll alive', async () => {
  await browser.storage.local.set({
    [SHARED_IDLE_POLL_KEY]: { lastAt: Date.now() },
    [SHARED_PENDING_INVITES_KEY]: { invites: [{ folderId: 'f1' }], notifiedFolderIds: [] },
  });
  await syncSharedFolders();
  expect(global.fetch.mock.calls.some(([u]) => u.includes('/shared/invites'))).toBe(true);
});

test('a local shared folder keeps the per-tick sync alive regardless of the idle stamp', async () => {
  global.fetch = jest.fn(async (url) => {
    if (url.includes('/shared/invites')) return okJson({ invites: [] });
    if (url.endsWith('/shared/folders')) return okJson({ folders: [{ folderId: 'f1', revision: 3, role: 'write' }] });
    if (url.includes('/shared/folders/f1')) return okJson({ folder: { name: 'Team' }, role: 'write', revision: 3, collections: [], activity: [] });
    throw new Error(`unexpected fetch ${url}`);
  });
  await browser.storage.local.set({
    [SHARED_IDLE_POLL_KEY]: { lastAt: Date.now() },
    folders_index: { f1: { uid: 'f1', name: 'Team', shared: { folderId: 'f1', role: 'write', ownerEmail: 'o@x.com' } } },
    folder_f1: { uid: 'f1', name: 'Team', shared: { folderId: 'f1', role: 'write', ownerEmail: 'o@x.com' } },
  });
  await syncSharedFolders();
  expect(global.fetch).toHaveBeenCalled();
});
