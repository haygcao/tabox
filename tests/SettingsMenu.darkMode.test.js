import { fireEvent, render, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { Provider, createStore } from 'jotai';
import SettingsMenu from '../app/SettingsMenu';
import { isLoggedInState, themeState } from '../app/atoms/globalAppSettingsState';

// Mock the AI client so these unrelated tests never touch the network.
jest.mock('../app/ai/aiClient', () => ({
    getAIAvailability: jest.fn().mockResolvedValue(undefined),
}));

const seedBrowserStorage = (data = {}) => {
    browser.storage.local._data = { ...data };

    browser.storage.local.get.mockImplementation(async (keys) => {
        if (!keys) {
            return browser.storage.local._data;
        }
        if (typeof keys === 'string') {
            return { [keys]: browser.storage.local._data[keys] };
        }
        if (Array.isArray(keys)) {
            return keys.reduce((result, key) => {
                result[key] = browser.storage.local._data[key];
                return result;
            }, {});
        }
        return Object.entries(keys).reduce((result, [key, fallback]) => {
            result[key] = browser.storage.local._data[key] ?? fallback;
            return result;
        }, {});
    });

    browser.storage.local.set.mockImplementation(async (items) => {
        Object.assign(browser.storage.local._data, items);
    });
};

const renderSettingsMenu = ({ theme = 'dark', storageData = {} } = {}) => {
    seedBrowserStorage(storageData);
    browser.runtime.sendMessage.mockResolvedValue(undefined);

    const store = createStore();
    store.set(isLoggedInState, false);
    store.set(themeState, theme);

    const view = render(
        <Provider store={store}>
            <SettingsMenu
                variant="fullpage"
                updateRemoteData={jest.fn()}
                applyDataFromServer={jest.fn()}
            />
        </Provider>,
    );

    return { ...view, store };
};

const openSettings = (container) => {
    fireEvent.click(container.querySelector('.settings-button'));
};

describe('SettingsMenu dark mode toggle', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        document.documentElement.setAttribute('data-theme', 'dark');
    });

    test('switch reflects the active theme even when darkModeToggle storage is stale', async () => {
        // Symptom scenario: UI is in dark mode (theme atom = 'dark') but the
        // legacy darkModeToggle key says false (e.g. OS-derived theme never persisted).
        const { container } = renderSettingsMenu({
            theme: 'dark',
            storageData: { darkModeToggle: false },
        });

        openSettings(container);

        const checkbox = await waitFor(() => {
            const el = document.querySelector('#darkModeToggle');
            expect(el).toBeInTheDocument();
            return el;
        });

        await waitFor(() => expect(checkbox).toBeChecked());
    });

    test('activating the checkbox directly (keyboard path) updates the theme too', async () => {
        const { container, store } = renderSettingsMenu({
            theme: 'dark',
            storageData: { theme: 'dark', darkModeToggle: true },
        });

        openSettings(container);

        const checkbox = await waitFor(() => {
            const el = document.querySelector('#darkModeToggle');
            expect(el).toBeInTheDocument();
            return el;
        });
        await waitFor(() => expect(checkbox).toBeChecked());

        // fireEvent.click on the input fires the change event without any
        // mouseup — same as toggling via keyboard (Space).
        fireEvent.click(checkbox);

        await waitFor(() => {
            expect(browser.storage.local._data.theme).toBe('light');
            expect(browser.storage.local._data.darkModeToggle).toBe(false);
        });
        expect(store.get(themeState)).toBe('light');
        expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    });

    test('toggling twice returns to the original state (no inversion)', async () => {
        const { container, store } = renderSettingsMenu({
            theme: 'dark',
            storageData: { theme: 'dark', darkModeToggle: true },
        });

        openSettings(container);

        const checkbox = await waitFor(() => {
            const el = document.querySelector('#darkModeToggle');
            expect(el).toBeInTheDocument();
            return el;
        });
        await waitFor(() => expect(checkbox).toBeChecked());

        fireEvent.click(checkbox);
        await waitFor(() => expect(store.get(themeState)).toBe('light'));
        await waitFor(() => expect(checkbox).not.toBeChecked());

        fireEvent.click(checkbox);
        await waitFor(() => expect(store.get(themeState)).toBe('dark'));
        await waitFor(() => expect(checkbox).toBeChecked());

        expect(browser.storage.local._data.theme).toBe('dark');
        expect(browser.storage.local._data.darkModeToggle).toBe(true);
    });
});
