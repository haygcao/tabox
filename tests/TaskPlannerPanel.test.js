/** @jest-environment jsdom */
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { Provider, createStore } from 'jotai';

jest.mock('../app/utils/storageUtils', () => ({ loadAllCollections: jest.fn().mockResolvedValue([]) }));
jest.mock('../app/toastHelpers', () => ({ showUndoToast: jest.fn(), showSuccessToast: jest.fn() }));

import TaskPlannerPanel from '../app/ai/TaskPlannerPanel';
import { loadAllCollections } from '../app/utils/storageUtils';
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

const renderPanel = async ({ updateRemoteData = jest.fn(), onDataUpdate = jest.fn() } = {}) => {
    const store = createStore();
    await act(async () => {
        render(
            <Provider store={store}>
                <TaskPlannerPanel updateRemoteData={updateRemoteData} onDataUpdate={onDataUpdate} />
            </Provider>
        );
    });
    return { store, updateRemoteData, onDataUpdate };
};

beforeEach(() => {
    jest.clearAllMocks();
    loadAllCollections.mockResolvedValue([]);
    storageListeners = [];
    browser.storage.onChanged.addListener = jest.fn((fn) => { storageListeners.push(fn); });
    browser.storage.onChanged.removeListener = jest.fn((fn) => {
        storageListeners = storageListeners.filter((f) => f !== fn);
    });
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

test('save builds the collection (groups + groupUids) and calls updateRemoteData with the AI name', async () => {
    const existing = { uid: 'existing', name: 'Old', tabs: [], chromeGroups: [] };
    loadAllCollections.mockResolvedValue([existing]);
    mockMessages({
        // Mount start returns the in-progress plan; the post-save force start
        // returns a fresh session.
        taskPlannerStart: (msg) => ((msg.payload && msg.payload.force)
            ? { ok: true, state: baseSession() }
            : { ok: true, state: baseSession({ groups: GROUPS, collectionName: 'Japan Trip' }) }),
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
    // The session is reset and a fresh plan started (force) after saving;
    // the mount itself sent the first (plain) start.
    expect(sentMessages('taskPlannerReset')).toHaveLength(1);
    expect(sentMessages('taskPlannerStart')).toEqual([
        { type: 'taskPlannerStart' },
        { type: 'taskPlannerStart', payload: { force: true } },
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
