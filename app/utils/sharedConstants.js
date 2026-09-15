/**
 * Shared Constants for Tabox
 * These constants are used across both app and background scripts
 * to ensure consistency and avoid duplication.
 */

// Storage key constants
export const STORAGE_KEYS = {
    COLLECTIONS_INDEX: 'collections_index',
    FOLDERS_INDEX: 'folders_index',
    LEGACY_TABS_ARRAY: 'tabsArray',
    DELETED_COLLECTION_TOMBSTONES: 'deleted_collection_tombstones',
    DELETED_FOLDER_TOMBSTONES: 'deleted_folder_tombstones',
    COLLECTION_PREFIX: 'collection_',
    FOLDER_PREFIX: 'folder_',
    STORAGE_VERSION: 'tabox_storage_version'
};

export const CURRENT_STORAGE_VERSION = 3;

// Favicon shown when a tab has no favIconUrl or its favicon fails to load
export const FALLBACK_FAVICON = './images/favicon-fallback.png';

// A collection must have at least this many tabs to qualify for AI splitting.
export { SPLIT_MIN_TABS } from '../../chrome/ai-hub-core';

/**
 * Returns `url` if it's safe to use as an <img src> for a favicon (protocol
 * http:, https:, or data: only), otherwise `fallback` (default FALLBACK_FAVICON,
 * pass `null` to conditionally skip rendering instead).
 *
 * Some tabs report privileged-scheme favIconUrl values — Firefox uses
 * chrome://mozapps/skin/... for its own internal pages, and Chrome-authored
 * collections synced/imported from older builds can carry chrome:// favicons
 * too — and an extension page is not allowed to load those as images
 * (Firefox: "Content at moz-extension://... may not load or link to
 * chrome://..." Security Error). This is a render-time guard only; it never
 * mutates the stored favIconUrl value.
 * @param {unknown} url
 * @param {string|null} [fallback]
 * @returns {string|null}
 */
export const safeFavIconUrl = (url, fallback = FALLBACK_FAVICON) => {
    if (typeof url !== 'string' || !url) return fallback;
    try {
        const { protocol } = new URL(url);
        return (protocol === 'http:' || protocol === 'https:' || protocol === 'data:') ? url : fallback;
    } catch {
        return fallback;
    }
};

// Simple UID generator (same logic throughout the app)
export const generateUid = () => {
    return (crypto && crypto.randomUUID) ? 
        crypto.randomUUID() : 
        Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
};
