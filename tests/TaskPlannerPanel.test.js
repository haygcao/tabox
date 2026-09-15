/** @jest-environment jsdom */
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { Provider, createStore } from 'jotai';

jest.mock('../app/utils/storageUtils', () => ({
    loadAllCollections: jest.fn().mockResolvedValue([]),
    loadSingleCollection: jest.fn().mockResolvedValue(null),
    loadAllFolders: jest.fn().mockResolvedValue([]),
}));
jest.mock('../app/utils/folderOperations', () => ({ moveCollectionToFolder: jest.fn() }));
jest.mock('../app/toastHelpers', () => ({ showUndoToast: jest.fn(), showSuccessToast: jest.fn() }));

import TaskPlannerPanel from '../app/ai/TaskPlannerPanel';
import { loadAllCollections, loadSingleCollection, loadAllFolders } from '../app/utils/storageUtils';
import { moveCollectionToFolder } from '../app/utils/folderOperations';
import { shareCollectionLinkModalState } from '../app/atoms/sharedFoldersState';
import { showSuccessToast } from '../app/toastHelpers';
import { browser } from '../static/globals';

// Captured storage.onChanged listener(s) so tests can simulate the SW writing
// taskPlannerSession (the panel's source of truth).
let storageListeners;

const fireSessionChange = async (newValue) => {
    await act(async () => {
        storageListeners.forEach((fn) => fn({ taskPlannerSession: { newValue } }, 'local'));
    });
};

const baseSession = (over = {}) => ({
    sessionId: 's1',
    status: 'ready',
    greeting: 'Hi! What are you planning? I\'ll gather the right websites.',
    pills: null,
    messages: [],
    groups: [],
    collectionName: '',
    error: null,
    createdAt: 1,
    updatedAt: 1,
    ...over,
});

const GROUPS = [
    {
        uid: 'g1',
        title: 'Flights',
        color: 'blue',
        tabs: [
            { uid: 't1', title: 'Google Flights', url: 'https://flights.google.com/' },
            { uid: 't2', title: 'Kayak', url: 'https://kayak.com/' },
        ],
    },
    {
        uid: 'g2',
        title: 'Hotels',
        color: 'red',
        tabs: [
            { uid: 't3', title: 'Booking.com', url: 'https://booking.com/' },
        ],
    },
];

// Routes runtime messages to canned replies; unrouted types resolve {ok:true}.
const mockMessages = (handlers = {}) => {
    browser.runtime.sendMessage = jest.fn().mockImplementation((msg) => {
        if (handlers[msg.type]) return Promise.resolve(handlers[msg.type](msg));
        return Promise.resolve({ ok: true });
    });
    return browser.runtime.sendMessage;
};

const sentMessages = (type) => browser.runtime.sendMessage.mock.calls
    .map((c) => c[0])
    .filter((m) => m.type === type);

const renderPanel = async ({ updateRemoteData = jest.fn(), onDataUpdate = jest.fn(), ...props } = {}) => {
    const store = createStore();
    await act(async () => {
        render(
            <Provider store={store}>
                <TaskPlannerPanel updateRemoteData={updateRemoteData} onDataUpdate={onDataUpdate} {...props} />
            </Provider>
        );
    });
    return { store, updateRemoteData, onDataUpdate };
};

beforeEach(() => {
    jest.clearAllMocks();
    loadAllCollections.mockResolvedValue([]);
    loadSingleCollection.mockResolvedValue(null);
    storageListeners = [];
    browser.storage.onChanged.addListener = jest.fn((fn) => { storageListeners.push(fn); });
    browser.storage.onChanged.removeListener = jest.fn((fn) => {
        storageListeners = storageListeners.filter((f) => f !== fn);
    });
});

test('suggestions stay outside the scrolling transcript immediately above the composer', async () => {
    mockMessages({ taskPlannerStart: () => ({ ok: true, state: baseSession({ messages: [{ id: 'm', role: 'user', content: 'Done' }] }) }) });
    await renderPanel({ hub: { completed: true, collections: [] } });
    const suggestions = screen.getByLabelText('Suggested next actions');
    expect(suggestions.closest('.tp-messages')).toBeNull();
    expect(suggestions.nextElementSibling).toHaveClass('tp-composer');
});

test('an unavailable action is explained in chat without an action card', async () => {
    mockMessages({ taskPlannerStart: () => ({ ok: true, state: baseSession() }) });
    await renderPanel({ hub: { activeTool: 'smart-organize', unavailable: 'All your tabs are already grouped.', collections: [] } });
    expect(screen.getByText('All your tabs are already grouped.').closest('.tp-messages')).not.toBeNull();
    expect(screen.queryByRole('region', { name: 'AI action' })).not.toBeInTheDocument();
});

test('a collection plan opens a live side panel and keeps updating during chat', async () => {
    mockMessages({ taskPlannerStart: () => ({ ok: true, state: baseSession({ groups: GROUPS, messages: [{ id: 'm', role: 'user', content: 'Plan a trip' }] }) }) });
    await renderPanel({ hub: { activeTool: 'task-planner', collections: [] } });
    const panel = screen.getByRole('complementary', { name: 'Current collection' });
    expect(screen.getByText('Google Flights').closest('aside')).toBe(panel);
    await fireSessionChange(baseSession({ status: 'thinking', groups: GROUPS }));
    expect(screen.getByRole('complementary', { name: 'Current collection' })).toBe(panel);
    await fireSessionChange(baseSession({ groups: [...GROUPS, { uid: 'food', title: 'Food', color: 'red', tabs: [{ uid: 'food1', title: 'Local food', url: 'https://example.com' }] }] }));
    expect(screen.getByText('Local food').closest('aside')).toBe(panel);
});

test('choosing the planner alone does not open an empty side panel', async () => {
    mockMessages({ taskPlannerStart: () => ({ ok: true, state: baseSession({ messages: [{ id: 'm', role: 'user', content: 'Plan something' }] }) }) });
    await renderPanel({ hub: { activeTool: 'task-planner', collections: [] } });
    expect(screen.queryByRole('complementary', { name: 'Current collection' })).not.toBeInTheDocument();
});

test('welcome has three starting prompts and hides contextual suggestions during review', async () => {
    mockMessages({ taskPlannerStart: () => ({ ok: true, state: baseSession() }) });
    await renderPanel({ hub: { collections: [] } });
    expect(screen.getByRole('heading', { name: 'What would you like to do?' })).toBeVisible();
    expect(document.querySelectorAll('.ai-hub-start-prompts button')).toHaveLength(4);
    expect(document.querySelector('.ai-hub-welcome')).not.toBeNull();
    expect(screen.queryByLabelText('Suggested next actions')).not.toBeInTheDocument();
});

test('New chat resets persisted conversation, clears the draft, and returns the hub home', async () => {
    const onReset = jest.fn();
    mockMessages({ taskPlannerStart: msg => ({ ok: true, state: msg.payload?.force ? baseSession({ sessionId: 'fresh' }) : baseSession({ messages: [{ id: 'old', role: 'user', content: 'Old request' }] }) }) });
    await renderPanel({ hub: { collections: [], onReset } });
    fireEvent.change(screen.getByLabelText('Message Tabox AI'), { target: { value: 'Unsent draft' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'New Chat' })); });
    expect(sentMessages('taskPlannerReset')).toHaveLength(1);
    expect(screen.queryByText('Old request')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Message Tabox AI')).toHaveValue('');
    expect(onReset).toHaveBeenCalledTimes(1);
});

test('New chat is disabled while an AI action is running', async () => {
    mockMessages({ taskPlannerStart: () => ({ ok: true, state: baseSession() }) });
    await renderPanel({ hub: { collections: [], busy: true } });
    expect(screen.getByRole('button', { name: 'New Chat' })).toBeDisabled();
});

test('a failed chat reset keeps the conversation and reports the error', async () => {
    const onReset = jest.fn();
    mockMessages({ taskPlannerStart: () => ({ ok: true, state: baseSession({ messages: [{ id: 'old', role: 'user', content: 'Old request' }] }) }), taskPlannerReset: () => ({ ok: false, error: 'Storage unavailable' }) });
    await renderPanel({ hub: { collections: [], onReset } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'New Chat' })); });
    expect(screen.getByText('Old request')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Storage unavailable');
    // The clear is optimistic (instant new chat), so the hub reset already ran;
    // the failure restores the transcript.
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(sentMessages('taskPlannerStart')).toHaveLength(1);
});

test('hub keeps contextual pills after the first message and sends a grounded action', async () => {
    mockMessages({ taskPlannerStart: () => ({ ok: true, state: baseSession({ messages: [{ id: 'm', role: 'user', content: 'Hello' }], pills: [] }) }) });
    await renderPanel({ hub: { activeTool: 'auto-rename', collections: [{ uid: 'big', name: 'Research', tabs: Array.from({ length: 42 }, () => ({ url: 'https://example.com' })) }], scope: { type: 'all' }, onAction: jest.fn() } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Split Research/ })); });
    expect(sentMessages('taskPlannerSend')[0].payload).toMatchObject({ hub: true, action: { tool: 'split-collection', uids: ['big'] } });
});

test('hub renders another tool inside the same conversation and preserves the composer', async () => {
    mockMessages({ taskPlannerStart: () => ({ ok: true, state: baseSession({ messages: [{ id: 'm', role: 'user', content: 'Keep my transcript' }] }) }) });
    await renderPanel({ hub: { activeTool: 'split-collection', collections: [], panel: <button>Review split</button>, onAction: jest.fn() } });
    expect(screen.getByText('Keep my transcript')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Review split' }).closest('.tp-messages')).not.toBeNull();
    expect(document.querySelector('.ai-hub-review')).toBeNull();
    expect(screen.getByLabelText('Message Tabox AI')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save collection' })).not.toBeInTheDocument();
});

test('hub shows thinking before revealing its inline action card', async () => {
    mockMessages({ taskPlannerStart: () => ({ ok: true, state: baseSession({ status: 'thinking' }) }) });
    await renderPanel({ hub: { activeTool: 'auto-rename', collections: [], panel: <button>Rename now</button>, onAction: jest.fn() } });
    expect(screen.getByTestId('tp-thinking')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Rename now' })).not.toBeInTheDocument();
    await fireSessionChange(baseSession({ status: 'ready', messages: [{ id: 'answer', role: 'assistant', content: 'I can name those collections.' }] }));
    expect(screen.getByRole('button', { name: 'Rename now' }).closest('.tp-messages')).not.toBeNull();
});

test('find-tab results render under the reply and open the saved tab on click', async () => {
    const tabResults = [
        { collectionUid: 'c1', collectionName: 'Work', title: 'Interview notes - Dima Aluf', url: 'https://docs.google.com/d/1', favIconUrl: 'https://docs.google.com/favicon.ico' },
        { collectionUid: 'c2', collectionName: 'Fun', title: 'Recipes', url: 'https://example.com/aluf', favIconUrl: null },
    ];
    mockMessages({ taskPlannerStart: () => ({ ok: true, state: baseSession({
        hubAction: { id: 'q', tool: 'find-tab', query: 'aluf' },
        messages: [{ id: 'q', role: 'user', content: 'find aluf' }, { id: 'a', role: 'assistant', content: 'Here is what I found.', tabResults }],
    }) }) });
    const onAction = jest.fn();
    browser.tabs.create = jest.fn().mockResolvedValue({});
    await renderPanel({ hub: { collections: [], panel: <button>Rename now</button>, onAction } });
    const list = screen.getByTestId('tp-tab-results');
    const rows = list.querySelectorAll('.tp-tab-result');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Interview notes - Dima Aluf');
    expect(rows[0]).toHaveTextContent('Work');
    fireEvent.click(rows[0]);
    expect(browser.tabs.create).toHaveBeenCalledWith({ url: 'https://docs.google.com/d/1' });
    // find-tab is card-less like clarify: no tool is adopted, no panel shown.
    expect(onAction).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Rename now' })).not.toBeInTheDocument();
});

test('hub welcome offers a find-a-tab prompt that routes straight to find-tab', async () => {
    mockMessages({ taskPlannerStart: () => ({ ok: true, state: baseSession() }) });
    await renderPanel({ hub: { collections: [], onAction: jest.fn() } });
    fireEvent.click(screen.getByRole('button', { name: 'Find a saved tab' }));
    await waitFor(() => expect(sentMessages('taskPlannerSend')).toHaveLength(1));
    expect(sentMessages('taskPlannerSend')[0].payload).toMatchObject({ hub: true, text: 'Find a saved tab', action: { tool: 'find-tab', uids: [] } });
});

test('a plain chat answer does not attach the previous action card', async () => {
    mockMessages({ taskPlannerStart: () => ({ ok: true, state: baseSession({ hubAction: { id: 'answer', tool: 'clarify' }, messages: [{ id: 'answer', role: 'assistant', content: 'You have seven collections.' }] }) }) });
    await renderPanel({ hub: { activeTool: 'auto-rename', collections: [], panel: <button>Rename now</button>, onAction: jest.fn() } });
    expect(screen.getByText('You have seven collections.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Rename now' })).not.toBeInTheDocument();
});

test('sharing from the hub stays inside its review area instead of opening another modal', async () => {
    mockMessages({ taskPlannerStart: () => ({ ok: true, state: baseSession({ linkedCollectionUid: 'c1', messages: [{ id: 'saved', role: 'assistant', content: 'Saved', offer: true }] }) }) });
    loadSingleCollection.mockResolvedValue({ uid: 'c1', name: 'Research', tabs: [] });
    const { store } = await renderPanel({ hub: { activeTool: 'task-planner', collections: [], onAction: jest.fn() } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Share via link/ })); });
    expect(store.get(shareCollectionLinkModalState)).toBeNull();
    expect(screen.getByRole('region', { name: 'Share Research via link' })).toBeInTheDocument();
    expect(screen.getByLabelText('Message Tabox AI')).toBeInTheDocument();
});

test('a slow suggestion reply cannot replace newer conversation events', async () => {
    let finish;
    mockMessages({ taskPlannerStart: () => ({ ok: true, state: baseSession({ pills: ['Plan a trip'] }) }), taskPlannerRefreshPills: () => new Promise(resolve => { finish = resolve; }) });
    await renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'New ideas' }));
    await fireSessionChange(baseSession({ status: 'thinking', messages: [{ id: 'new', role: 'user', content: 'My newer request' }], updatedAt: 20 }));
    await act(async () => { finish({ ok: true, state: baseSession({ updatedAt: 10 }) }); });
    expect(screen.getByText('My newer request')).toBeInTheDocument();
    expect(screen.getByLabelText('Message Tabox AI')).toBeDisabled();
});

test('renders the greeting and shimmer skeleton pills while pills are loading', async () => {
    mockMessages({ taskPlannerStart: () => ({ ok: true, state: baseSession({ pills: null }) }) });
    await renderPanel();

    expect(screen.getByText(/what are you planning/i)).toBeInTheDocument();
    expect(screen.getAllByTestId('tp-pill-skeleton')).toHaveLength(3);
});

test('mount sends a single unconditional taskPlannerStart and adopts its state', async () => {
    mockMessages({
        taskPlannerStart: () => ({ ok: true, state: baseSession() }),
    });
    await renderPanel();

    // One plain start (no force) — the SW reuses fresh sessions, replaces
    // expired ones, and heals stale thinking, so no getState-then-start dance.
    expect(sentMessages('taskPlannerStart')).toEqual([{ type: 'taskPlannerStart' }]);
    expect(sentMessages('taskPlannerGetState')).toHaveLength(0);
    expect(await screen.findByText(/what are you planning/i)).toBeInTheDocument();
});

test('renders suggestion pills and clicking one sends it as the user message', async () => {
    const pills = ['Plan a trip to Japan', 'Research standing desks', 'Compare laptops'];
    mockMessages({ taskPlannerStart: () => ({ ok: true, state: baseSession({ pills }) }) });
    await renderPanel();

    for (const pill of pills) {
        expect(screen.getByRole('button', { name: pill })).toBeInTheDocument();
    }

    await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Plan a trip to Japan' }));
    });

    expect(sentMessages('taskPlannerSend')).toEqual([
        { type: 'taskPlannerSend', payload: { text: 'Plan a trip to Japan' } },
    ]);
});

test('disables the composer and shows the thinking bubble while status is thinking', async () => {
    mockMessages({
        taskPlannerStart: () => ({
            ok: true,
            state: baseSession({
                status: 'thinking',
                pills: ['Plan a trip'],
                messages: [{ id: 'm1', role: 'user', content: 'Plan a trip to Japan', ts: 1 }],
            }),
        }),
    });
    await renderPanel();

    expect(screen.getByLabelText('Message Tabox AI')).toBeDisabled();
    expect(screen.getByLabelText('Send message')).toBeDisabled();
    expect(screen.getByTestId('tp-thinking')).toBeInTheDocument();
    // Pills are gone once the user has sent a message.
    expect(screen.queryByTestId('tp-pills')).not.toBeInTheDocument();
});

test('renders groups and tabs from state; the remove button sends taskPlannerRemoveTab', async () => {
    mockMessages({
        taskPlannerStart: () => ({
            ok: true,
            state: baseSession({ groups: GROUPS, collectionName: 'Japan Trip' }),
        }),
    });
    await renderPanel();

    expect(screen.getByText('Flights')).toBeInTheDocument();
    expect(screen.getByText('Hotels')).toBeInTheDocument();
    expect(screen.getByText('Google Flights')).toBeInTheDocument();
    expect(screen.getByText('Kayak')).toBeInTheDocument();
    expect(screen.getByText('Booking.com')).toBeInTheDocument();
    expect(screen.getByText('3 tabs')).toBeInTheDocument();
    expect(screen.getByLabelText('Collection name')).toHaveValue('Japan Trip');

    await act(async () => {
        fireEvent.click(screen.getAllByLabelText('Remove tab')[0]);
    });

    expect(sentMessages('taskPlannerRemoveTab')).toEqual([
        { type: 'taskPlannerRemoveTab', payload: { groupUid: 'g1', tabUid: 't1' } },
    ]);
});

test('save builds the collection (groups + groupUids), links via markSaved, and does NOT reset the chat', async () => {
    const existing = { uid: 'existing', name: 'Old', tabs: [], chromeGroups: [] };
    loadAllCollections.mockResolvedValue([existing]);
    mockMessages({
        taskPlannerStart: () => ({
            ok: true,
            state: baseSession({
                groups: GROUPS,
                collectionName: 'Japan Trip',
                messages: [
                    { id: 'm1', role: 'user', content: 'Plan a trip to Japan', ts: 1 },
                    { id: 'm2', role: 'assistant', content: 'Here are some starting points.', ts: 2 },
                ],
            }),
        }),
    });
    const updateRemoteData = jest.fn().mockResolvedValue(undefined);
    await renderPanel({ updateRemoteData });

    await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /save collection/i }));
    });

    await waitFor(() => expect(updateRemoteData).toHaveBeenCalledTimes(1));
    const written = updateRemoteData.mock.calls[0][0];
    expect(written).toHaveLength(2);
    expect(written[0]).toBe(existing);

    const collection = written[1];
    expect(collection.name).toBe('Japan Trip');
    expect(collection.chromeGroups).toEqual([
        expect.objectContaining({ id: 1, title: 'Flights', color: 'blue', collapsed: false }),
        expect.objectContaining({ id: 2, title: 'Hotels', color: 'red', collapsed: false }),
    ]);
    expect(collection.tabs.map((t) => t.groupId)).toEqual([1, 1, 2]);
    expect(collection.tabs.map((t) => t.url)).toEqual([
        'https://flights.google.com/',
        'https://kayak.com/',
        'https://booking.com/',
    ]);
    // applyUid wires every tab's groupUid to its group's minted uid.
    const groupUidById = Object.fromEntries(collection.chromeGroups.map((g) => [g.id, g.uid]));
    for (const tab of collection.tabs) {
        expect(tab.uid).toBeTruthy();
        expect(tab.groupUid).toBe(groupUidById[tab.groupId]);
    }

    expect(showSuccessToast).toHaveBeenCalledWith('Collection saved!');
    // Saving no longer resets the chat: the session gets LINKED to the saved
    // collection instead, so the user can keep refining and update in place.
    expect(sentMessages('taskPlannerReset')).toHaveLength(0);
    expect(sentMessages('taskPlannerStart')).toEqual([{ type: 'taskPlannerStart' }]);
    expect(sentMessages('taskPlannerMarkSaved')).toEqual([
        { type: 'taskPlannerMarkSaved', payload: { uid: collection.uid, name: 'Japan Trip' } },
    ]);
    // Transcript and tab set survive the save.
    expect(screen.getByText('Plan a trip to Japan')).toBeInTheDocument();
    expect(screen.getByText('Here are some starting points.')).toBeInTheDocument();
    expect(screen.getByText('Google Flights')).toBeInTheDocument();
});

test('linked session shows Update collection and updates the collection in place', async () => {
    const other = { uid: 'other', name: 'Other', tabs: [], chromeGroups: [] };
    const existing = {
        uid: 'lk1',
        name: 'Japan Trip',
        parentId: 'folder1',
        color: '#123456',
        createdOn: 111,
        order: 3,
        isFavorite: true,
        favoriteOrder: 2,
        tabs: [],
        chromeGroups: [],
    };
    loadAllCollections.mockResolvedValue([other, existing]);
    mockMessages({
        taskPlannerStart: () => ({
            ok: true,
            state: baseSession({
                groups: GROUPS,
                collectionName: 'Japan Trip',
                linkedCollectionUid: 'lk1',
                messages: [{ id: 'm1', role: 'user', content: 'Plan a trip to Japan', ts: 1 }],
            }),
        }),
    });
    const updateRemoteData = jest.fn().mockResolvedValue(undefined);
    await renderPanel({ updateRemoteData });

    expect(screen.queryByRole('button', { name: /save collection/i })).not.toBeInTheDocument();
    await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /update collection/i }));
    });

    await waitFor(() => expect(updateRemoteData).toHaveBeenCalledTimes(1));
    const written = updateRemoteData.mock.calls[0][0];
    // In-place replacement: no new collection appended, `other` untouched.
    expect(written).toHaveLength(2);
    expect(written[0]).toBe(other);

    const updated = written[1];
    expect(updated).not.toBe(existing);
    expect(updated.uid).toBe('lk1');
    // Identity/metadata preserved from the stored record.
    expect(updated.parentId).toBe('folder1');
    expect(updated.color).toBe('#123456');
    expect(updated.createdOn).toBe(111);
    expect(updated.order).toBe(3);
    expect(updated.isFavorite).toBe(true);
    expect(updated.favoriteOrder).toBe(2);
    // Content comes from the session.
    expect(updated.tabs.map((t) => t.url)).toEqual([
        'https://flights.google.com/',
        'https://kayak.com/',
        'https://booking.com/',
    ]);
    expect(updated.chromeGroups.map((g) => g.title)).toEqual(['Flights', 'Hotels']);

    expect(showSuccessToast).toHaveBeenCalledWith('Collection updated!');
    // Already linked — no re-link message, no reset.
    expect(sentMessages('taskPlannerMarkSaved')).toHaveLength(0);
    expect(sentMessages('taskPlannerReset')).toHaveLength(0);
});

test('linked but deleted collection falls back to append + markSaved re-link', async () => {
    const other = { uid: 'other', name: 'Other', tabs: [], chromeGroups: [] };
    loadAllCollections.mockResolvedValue([other]); // linked uid gone from storage
    mockMessages({
        taskPlannerStart: () => ({
            ok: true,
            state: baseSession({
                groups: GROUPS,
                collectionName: 'Japan Trip',
                linkedCollectionUid: 'deleted-uid',
            }),
        }),
    });
    const updateRemoteData = jest.fn().mockResolvedValue(undefined);
    await renderPanel({ updateRemoteData });

    await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /update collection/i }));
    });

    await waitFor(() => expect(updateRemoteData).toHaveBeenCalledTimes(1));
    const written = updateRemoteData.mock.calls[0][0];
    expect(written).toHaveLength(2);
    expect(written[0]).toBe(other);
    const collection = written[1];
    expect(collection.uid).not.toBe('deleted-uid');
    expect(collection.name).toBe('Japan Trip');

    expect(showSuccessToast).toHaveBeenCalledWith('Collection saved!');
    // Re-linked to the NEW uid.
    expect(sentMessages('taskPlannerMarkSaved')).toEqual([
        { type: 'taskPlannerMarkSaved', payload: { uid: collection.uid, name: 'Japan Trip' } },
    ]);
});

test('save is disabled with no collected tabs', async () => {
    mockMessages({ taskPlannerStart: () => ({ ok: true, state: baseSession({ pills: [] }) }) });
    await renderPanel();
    expect(screen.getByRole('button', { name: /save collection/i })).toBeDisabled();
});

test('storage.onChanged updates re-render the transcript and tabs panel', async () => {
    mockMessages({ taskPlannerStart: () => ({ ok: true, state: baseSession({ pills: [] }) }) });
    await renderPanel();

    expect(screen.queryByText('Here are some starting points.')).not.toBeInTheDocument();

    await fireSessionChange(baseSession({
        pills: [],
        messages: [
            { id: 'm1', role: 'user', content: 'Plan a trip to Japan', ts: 1 },
            { id: 'm2', role: 'assistant', content: 'Here are some starting points.', ts: 2 },
        ],
        groups: [GROUPS[0]],
        collectionName: 'Japan Trip',
    }));

    expect(screen.getByText('Plan a trip to Japan')).toBeInTheDocument();
    expect(screen.getByText('Here are some starting points.')).toBeInTheDocument();
    expect(screen.getByText('Flights')).toBeInTheDocument();
    expect(screen.getByText('2 tabs')).toBeInTheDocument();
    expect(screen.getByLabelText('Collection name')).toHaveValue('Japan Trip');
});

test('save is disabled while a turn is thinking', async () => {
    mockMessages({
        taskPlannerStart: () => ({
            ok: true,
            state: baseSession({
                status: 'thinking',
                groups: GROUPS,
                messages: [{ id: 'm1', role: 'user', content: 'Plan a trip to Japan', ts: 1 }],
            }),
        }),
    });
    await renderPanel();

    // Tabs are collected, but saving mid-turn would store a stale set.
    expect(screen.getByText('3 tabs')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save collection/i })).toBeDisabled();
});

test('save is disabled while a tab removal is pending', async () => {
    mockMessages({
        taskPlannerStart: () => ({ ok: true, state: baseSession({ groups: GROUPS }) }),
        // Removal acknowledged, but no storage change lands yet — the removed
        // tab is not out of the SW session, so Save must stay locked.
        taskPlannerRemoveTab: () => ({ ok: true, state: baseSession({ groups: GROUPS }) }),
    });
    await renderPanel();

    expect(screen.getByRole('button', { name: /save collection/i })).toBeEnabled();
    await act(async () => {
        fireEvent.click(screen.getAllByLabelText('Remove tab')[0]);
    });
    expect(screen.getByRole('button', { name: /save collection/i })).toBeDisabled();
});

test('a failed tab removal un-collapses the row and surfaces the error', async () => {
    mockMessages({
        taskPlannerStart: () => ({ ok: true, state: baseSession({ groups: GROUPS }) }),
        taskPlannerRemoveTab: () => ({ ok: false, error: 'Tab not found.' }),
    });
    await renderPanel();

    const row = screen.getByText('Google Flights').closest('li');
    await act(async () => {
        fireEvent.click(screen.getAllByLabelText('Remove tab')[0]);
    });

    expect(row).not.toHaveClass('tp-tab--removing');
    expect(screen.getByText('Tab not found.')).toBeInTheDocument();
    // No phantom collapse — Save is usable again.
    expect(screen.getByRole('button', { name: /save collection/i })).toBeEnabled();
});

test('an ignored send restores the composer text', async () => {
    mockMessages({
        taskPlannerStart: () => ({ ok: true, state: baseSession({ pills: [] }) }),
        // Thinking-collision: the SW acknowledges but does not append the turn.
        taskPlannerSend: () => ({ ok: true, state: baseSession({ pills: [] }), ignored: true }),
    });
    await renderPanel();

    const inputEl = screen.getByLabelText('Message Tabox AI');
    fireEvent.change(inputEl, { target: { value: 'Plan a trip to Japan' } });
    await act(async () => {
        fireEvent.keyDown(inputEl, { key: 'Enter' });
    });

    expect(sentMessages('taskPlannerSend')).toHaveLength(1);
    expect(inputEl).toHaveValue('Plan a trip to Japan');
});

test('Enter during IME composition does not send the message', async () => {
    mockMessages({ taskPlannerStart: () => ({ ok: true, state: baseSession({ pills: [] }) }) });
    await renderPanel();

    const inputEl = screen.getByLabelText('Message Tabox AI');
    fireEvent.change(inputEl, { target: { value: '日本旅行' } });
    await act(async () => {
        // isComposing is a KeyboardEventInit member, so it lands on the native
        // event React exposes as e.nativeEvent.
        fireEvent.keyDown(inputEl, { key: 'Enter', isComposing: true });
    });

    expect(sentMessages('taskPlannerSend')).toHaveLength(0);
    expect(inputEl).toHaveValue('日本旅行');
});

test('user edits to the collection name win over later AI updates', async () => {
    mockMessages({
        taskPlannerStart: () => ({ ok: true, state: baseSession({ collectionName: 'Japan Trip' }) }),
    });
    await renderPanel();

    const nameInput = screen.getByLabelText('Collection name');
    expect(nameInput).toHaveValue('Japan Trip');
    fireEvent.change(nameInput, { target: { value: 'My Japan Plan' } });

    await fireSessionChange(baseSession({ collectionName: 'Tokyo Adventure' }));

    expect(screen.getByLabelText('Collection name')).toHaveValue('My Japan Plan');
});

test('reload button sends taskPlannerRefreshPills and spins while a batch generates', async () => {
    const pills = ['Plan a trip', 'Research a topic', 'Learn a new skill'];
    mockMessages({ taskPlannerStart: () => ({ ok: true, state: baseSession({ pills }) }) });
    await renderPanel();

    const reload = screen.getByRole('button', { name: 'New ideas' });
    expect(reload).toBeEnabled();
    expect(reload.className).not.toContain('tp-pills-refresh--spinning');

    await act(async () => {
        fireEvent.click(reload);
    });
    expect(sentMessages('taskPlannerRefreshPills')).toHaveLength(1);

    // SW flips pills to null → skeletons show and the button spins, disabled.
    await fireSessionChange(baseSession({ pills: null }));
    const spinning = screen.getByRole('button', { name: 'New ideas' });
    expect(spinning.className).toContain('tp-pills-refresh--spinning');
    expect(spinning).toBeDisabled();
    expect(screen.getAllByTestId('tp-pill-skeleton')).toHaveLength(3);

    // Fresh batch lands.
    await fireSessionChange(baseSession({ pills: ['Plan a heist', 'Learn pottery', 'Track a comet'] }));
    expect(screen.getByRole('button', { name: 'Plan a heist' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New ideas' })).toBeEnabled();
});

test('choose-collection triggers are hidden while the session is linked', async () => {
    mockMessages({
        taskPlannerStart: () => ({
            ok: true,
            state: baseSession({ pills: [], linkedCollectionUid: 'lk1', groups: GROUPS }),
        }),
    });
    await renderPanel();

    expect(screen.queryByRole('button', { name: 'Start from a collection' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('tp-picker')).not.toBeInTheDocument();
});

test('choose-collection opens the picker, loads the pick, and sends the converted planner groups', async () => {
    // metadataOnly listing rows (index shape: uid + name + tabCount + lastUpdated).
    loadAllCollections.mockImplementation(async (options = {}) => {
        expect(options.metadataOnly).toBe(true);
        return [
            { uid: 'c-old', name: 'Older Collection', tabCount: 1, lastUpdated: 10 },
            { uid: 'c-research', name: 'Research Stack', tabCount: 3, lastUpdated: 99 },
        ];
    });
    // Full record for the picked collection: one real chrome group + one
    // ungrouped tab (falls into "More tabs" with a hostname title).
    loadSingleCollection.mockResolvedValue({
        uid: 'c-research',
        name: 'Research Stack',
        chromeGroups: [{ id: 1, uid: 'cg1', title: 'Sources', color: 'blue', collapsed: false }],
        tabs: [
            { uid: 'tA', title: 'Alpha', url: 'https://alpha.example.com/', groupId: 1, groupUid: 'cg1' },
            { uid: 'tB', title: '', url: 'https://beta.example.com/' },
        ],
    });
    mockMessages({
        taskPlannerStart: () => ({ ok: true, state: baseSession({ pills: [] }) }),
        taskPlannerLoadCollection: () => ({ ok: true, state: baseSession({ linkedCollectionUid: 'c-research' }) }),
    });
    await renderPanel();

    // Two triggers while unlinked: the header icon and the empty-state text
    // button (same accessible name).
    const triggers = screen.getAllByRole('button', { name: 'Start from a collection' });
    expect(triggers).toHaveLength(2);
    await act(async () => {
        fireEvent.click(triggers[0]);
    });

    // Picker lists the user's collections, most recently updated first.
    expect(screen.getByTestId('tp-picker')).toBeInTheDocument();
    expect(screen.getByText('Choose a collection')).toBeInTheDocument();
    const rows = screen.getAllByRole('button', { name: /Collection|Research Stack/ })
        .filter((b) => b.className.includes('tp-picker-row'));
    expect(rows.map((r) => r.textContent)).toEqual([
        'Research Stack3 tabs',
        'Older Collection1 tab',
    ]);

    await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Research Stack/ }));
    });

    expect(loadSingleCollection).toHaveBeenCalledWith('c-research');
    const loads = sentMessages('taskPlannerLoadCollection');
    expect(loads).toHaveLength(1);
    expect(loads[0].payload.uid).toBe('c-research');
    expect(loads[0].payload.name).toBe('Research Stack');
    // Converted planner-groups shape: grouped tab keeps its group (original
    // uid preserved); the ungrouped tab lands in a trailing "More tabs" group
    // with a hostname-derived title.
    expect(loads[0].payload.groups).toEqual([
        {
            uid: 'cg1',
            title: 'Sources',
            color: 'blue',
            tabs: [{ uid: 'tA', title: 'Alpha', url: 'https://alpha.example.com/' }],
        },
        {
            uid: expect.any(String),
            title: 'More tabs',
            color: 'grey',
            tabs: [{ uid: 'tB', title: 'beta.example.com', url: 'https://beta.example.com/' }],
        },
    ]);

    // Picker closes on a successful load (the linked state itself renders via
    // storage.onChanged from the SW).
    expect(screen.queryByTestId('tp-picker')).not.toBeInTheDocument();
});

test('a failed collection load surfaces the error and keeps the picker open', async () => {
    loadAllCollections.mockResolvedValue([{ uid: 'c1', name: 'Trip', tabCount: 2, lastUpdated: 1 }]);
    loadSingleCollection.mockResolvedValue({ uid: 'c1', name: 'Trip', tabs: [{ uid: 't', title: 'T', url: 'https://t.example.com/' }], chromeGroups: [] });
    mockMessages({
        taskPlannerStart: () => ({ ok: true, state: baseSession({ pills: [] }) }),
        taskPlannerLoadCollection: () => ({ ok: false, error: 'Session expired.' }),
    });
    await renderPanel();

    await act(async () => {
        fireEvent.click(screen.getAllByRole('button', { name: 'Start from a collection' })[0]);
    });
    await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Trip/ }));
    });

    expect(screen.getByText('Session expired.')).toBeInTheDocument();
    expect(screen.getByTestId('tp-picker')).toBeInTheDocument();
});

test('reload button disappears with the pills once the conversation starts', async () => {
    mockMessages({
        taskPlannerStart: () => ({ ok: true, state: baseSession({ pills: ['Plan a trip', 'Research a topic', 'Learn'] }) }),
    });
    await renderPanel();
    expect(screen.getByRole('button', { name: 'New ideas' })).toBeInTheDocument();

    await fireSessionChange(baseSession({
        pills: ['Plan a trip', 'Research a topic', 'Learn'],
        messages: [{ id: 'm1', role: 'user', content: 'Plan a trip', ts: 1 }],
    }));
    expect(screen.queryByRole('button', { name: 'New ideas' })).not.toBeInTheDocument();
});

// ── Post-save / post-link offer chips ───────────────────────────────────────

const OFFER_SESSION = (over = {}) => baseSession({
    pills: [],
    groups: GROUPS,
    linkedCollectionUid: 'col-1',
    collectionName: 'Trip',
    messages: [{
        id: 'm-offer',
        role: 'assistant',
        content: 'Saved "Trip"! Want to share it with someone or add it to a folder?',
        ts: 1,
        offer: true,
    }],
    ...over,
});

describe('offer chips', () => {
    test('renders share and folder chips under the latest offer message while linked', async () => {
        mockMessages({ taskPlannerStart: () => ({ ok: true, state: OFFER_SESSION() }) });
        await renderPanel();

        expect(screen.getByRole('button', { name: /Share via link/ })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Add to folder/ })).toBeInTheDocument();
    });

    test('only the latest offer message gets chips', async () => {
        const messages = [
            { id: 'm1', role: 'assistant', content: 'Loaded "Trip" — old offer.', ts: 1, offer: true },
            { id: 'm2', role: 'user', content: 'add hotels', ts: 2 },
            { id: 'm3', role: 'assistant', content: 'Saved "Trip"! Want to share it with someone or add it to a folder?', ts: 3, offer: true },
        ];
        mockMessages({ taskPlannerStart: () => ({ ok: true, state: OFFER_SESSION({ messages }) }) });
        await renderPanel();

        expect(screen.getAllByRole('button', { name: /Share via link/ })).toHaveLength(1);
    });

    test('hides chips when the session is not linked', async () => {
        mockMessages({ taskPlannerStart: () => ({ ok: true, state: OFFER_SESSION({ linkedCollectionUid: null }) }) });
        await renderPanel();

        expect(screen.queryByRole('button', { name: /Share via link/ })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Add to folder/ })).not.toBeInTheDocument();
    });

    test('share chip loads the collection and opens the share modal atom', async () => {
        const full = { uid: 'col-1', name: 'Trip', tabs: [], chromeGroups: [] };
        loadSingleCollection.mockResolvedValue(full);
        mockMessages({ taskPlannerStart: () => ({ ok: true, state: OFFER_SESSION() }) });
        const { store } = await renderPanel();

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: /Share via link/ }));
        });

        expect(loadSingleCollection).toHaveBeenCalledWith('col-1');
        expect(store.get(shareCollectionLinkModalState)).toBe(full);
    });

    test('share chip surfaces an error when the collection is gone', async () => {
        loadSingleCollection.mockResolvedValue(null);
        mockMessages({ taskPlannerStart: () => ({ ok: true, state: OFFER_SESSION() }) });
        const { store } = await renderPanel();

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: /Share via link/ }));
        });

        expect(screen.getByText(/Could not find the saved collection/)).toBeInTheDocument();
        expect(store.get(shareCollectionLinkModalState)).toBeNull();
    });

    test('chips are disabled while a turn is thinking', async () => {
        mockMessages({ taskPlannerStart: () => ({ ok: true, state: OFFER_SESSION({ status: 'thinking' }) }) });
        await renderPanel();

        expect(screen.getByRole('button', { name: /Share via link/ })).toBeDisabled();
        expect(screen.getByRole('button', { name: /Add to folder/ })).toBeDisabled();
    });
});

describe('add to folder picker', () => {
    const openOfferPicker = async () => {
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: /Add to folder/ }));
        });
    };

    test('folder chip opens a picker listing folders', async () => {
        loadAllFolders.mockResolvedValue([{ uid: 'f1', name: 'Work' }, { uid: 'f2', name: 'Travel' }]);
        mockMessages({ taskPlannerStart: () => ({ ok: true, state: OFFER_SESSION() }) });
        await renderPanel();
        await openOfferPicker();

        expect(loadAllFolders).toHaveBeenCalledWith({ metadataOnly: true });
        expect(screen.getByTestId('tp-folder-picker')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Work/ })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Travel/ })).toBeInTheDocument();
    });

    test('shows an empty state when there are no folders', async () => {
        loadAllFolders.mockResolvedValue([]);
        mockMessages({ taskPlannerStart: () => ({ ok: true, state: OFFER_SESSION() }) });
        await renderPanel();
        await openOfferPicker();

        expect(screen.getByText('No folders yet.')).toBeInTheDocument();
    });

    test('picking a folder moves the collection, refreshes, and toasts', async () => {
        loadAllFolders.mockResolvedValue([{ uid: 'f2', name: 'Travel' }]);
        moveCollectionToFolder.mockResolvedValue(true);
        mockMessages({ taskPlannerStart: () => ({ ok: true, state: OFFER_SESSION() }) });
        const { onDataUpdate } = await renderPanel();
        await openOfferPicker();

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: /Travel/ }));
        });

        expect(moveCollectionToFolder).toHaveBeenCalledWith('col-1', 'f2');
        expect(onDataUpdate).toHaveBeenCalled();
        expect(showSuccessToast).toHaveBeenCalledWith('Moved "Trip" to Travel');
        expect(screen.queryByTestId('tp-folder-picker')).not.toBeInTheDocument();
    });

    test('surfaces blocked moves as an error and keeps the picker open', async () => {
        loadAllFolders.mockResolvedValue([{ uid: 'f3', name: 'Shared' }]);
        moveCollectionToFolder.mockResolvedValue({ blocked: true });
        mockMessages({ taskPlannerStart: () => ({ ok: true, state: OFFER_SESSION() }) });
        await renderPanel();
        await openOfferPicker();

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: /Shared/ }));
        });

        expect(screen.getByText(/read-only/)).toBeInTheDocument();
        expect(screen.getByTestId('tp-folder-picker')).toBeInTheDocument();
    });

    test('surfaces a failed move as an error', async () => {
        loadAllFolders.mockResolvedValue([{ uid: 'f1', name: 'Work' }]);
        moveCollectionToFolder.mockResolvedValue(false);
        mockMessages({ taskPlannerStart: () => ({ ok: true, state: OFFER_SESSION() }) });
        await renderPanel();
        await openOfferPicker();

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: /Work/ }));
        });

        expect(screen.getByText(/Could not move the collection/)).toBeInTheDocument();
    });

    test('the picker can be closed without picking', async () => {
        loadAllFolders.mockResolvedValue([{ uid: 'f1', name: 'Work' }]);
        mockMessages({ taskPlannerStart: () => ({ ok: true, state: OFFER_SESSION() }) });
        await renderPanel();
        await openOfferPicker();

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Close folder picker' }));
        });
        expect(screen.queryByTestId('tp-folder-picker')).not.toBeInTheDocument();
    });
});
