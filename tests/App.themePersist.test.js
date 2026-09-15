const { render, waitFor, cleanup } = require('@testing-library/react');
require('@testing-library/jest-dom');
const { Provider, createStore } = require('jotai');

const { createBrowserHarness } = require('./helpers/browserHarness');

const mockBrowserProxy = new Proxy({}, {
    get(_target, property) {
        return global.browser?.[property];
    }
});

jest.mock('../static/globals', () => ({
    browser: mockBrowserProxy
}));

jest.mock('../app/Header', () => () => null);
jest.mock('../app/AddNewTextbox', () => () => null);
jest.mock('../app/CollectionList', () => () => null);
jest.mock('../app/Footer', () => () => null);
jest.mock('../app/fullpage/FPLayout', () => () => null);
jest.mock('../app/CommandPalette', () => () => null);
jest.mock('../app/CollectionListOptions', () => ({
    CollectionListOptions: () => null
}));
jest.mock('react-tooltip', () => ({ Tooltip: () => null }));

const App = require('../app/App').default;

describe('App theme persistence', () => {
    let browser;
    let originalMatchMedia;

    beforeEach(() => {
        cleanup();
        originalMatchMedia = window.matchMedia;
        window.matchMedia = jest.fn().mockReturnValue({ matches: true });
        browser = createBrowserHarness({
            localData: {
                collections_index: {},
                folders_index: {},
                tabox_storage_version: 3
            }
        });
        global.browser = browser;
        global.chrome = { runtime: browser.runtime };
    });

    afterEach(() => {
        cleanup();
        window.matchMedia = originalMatchMedia;
        delete global.browser;
        delete global.chrome;
    });

    test('persists the OS-derived theme to storage when no theme is stored', async () => {
        render(
            <Provider store={createStore()}>
                <App />
            </Provider>
        );

        await waitFor(async () => {
            const { theme } = await browser.storage.local.get('theme');
            expect(theme).toBe('dark');
        });
        expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    });

    test('does not overwrite an explicitly stored theme', async () => {
        await browser.storage.local.set({ theme: 'light' });

        render(
            <Provider store={createStore()}>
                <App />
            </Provider>
        );

        await waitFor(() => {
            expect(document.documentElement.getAttribute('data-theme')).toBe('light');
        });
        const { theme } = await browser.storage.local.get('theme');
        expect(theme).toBe('light');
    });
});
