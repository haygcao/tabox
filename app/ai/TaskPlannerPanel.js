import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSetAtom } from 'jotai';
import { MdClose, MdFolderOpen, MdRefresh, MdSend } from 'react-icons/md';
import { BsStars } from 'react-icons/bs';
import { aiProcessingUidsState } from '../atoms/aiState';
import TaboxCollection from '../model/TaboxCollection';
import { applyUid } from '../utils';
import { loadAllCollections, loadSingleCollection } from '../utils/storageUtils';
import plannerCore from '../../chrome/task-planner-core';
import { getColorCode } from '../utils/colorUtils';
import { FALLBACK_FAVICON } from '../utils/sharedConstants';
import { showSuccessToast } from '../toastHelpers';
import { browser } from '../../static/globals';
import './TaskPlannerPanel.css';

// chrome.storage.local key owned by the service worker's task-planner module.
// The panel renders EXCLUSIVELY from this session state: the initial
// taskPlannerStart reply plus the storage.onChanged subscription (the source
// of truth) — so a reopened popup reattaches to an in-flight chat for free.
const SESSION_KEY = 'taskPlannerSession';

// Rotating status lines shown while the AI is thinking; a new one is picked
// at random each turn.
const THINKING_MESSAGES = [
    'Sketching your plan…',
    'Scouting the best sites…',
    'Sorting tabs into groups…',
    'Curating your tabs…',
    'Mapping it out…',
    'Picking the good stuff…',
    'Lining up your links…',
    'Polishing the plan…',
];

// Google's favicon service for gathered tabs (the model supplies no favIconUrl);
// a broken load falls back to the bundled placeholder via onError.
const faviconFor = (url) => {
    try {
        const { hostname } = new URL(url);
        if (hostname) return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostname)}&sz=32`;
    } catch {
        // Malformed URL — use the bundled fallback below.
    }
    return FALLBACK_FAVICON;
};

const handleFaviconError = (e) => {
    const img = e.currentTarget;
    if (!img.dataset.fellBack) {
        img.dataset.fellBack = '1';
        img.src = FALLBACK_FAVICON;
    }
};

// Chat-style Task Planner panel (AI Tools modal, popup + full-page).
// The popup only initiates work and renders session state — every mutation
// (start/send/removeTab/reset) is a runtime message handled in the service
// worker, so closing the popup never aborts a turn.
function TaskPlannerPanel({ updateRemoteData, onDataUpdate }) {
    const setAiProcessingUids = useSetAtom(aiProcessingUidsState);

    const [session, setSession] = useState(null);
    const [input, setInput] = useState('');
    const [actionError, setActionError] = useState(null);
    const [saving, setSaving] = useState(false);
    const [thinkingMsg, setThinkingMsg] = useState(THINKING_MESSAGES[0]);
    // uids the user just removed — collapse them immediately while the SW write
    // is in flight (the storage change then drops them from the list for real).
    const [removingTabs, setRemovingTabs] = useState([]);

    // Inline collection picker ("Start from a collection"): while open it
    // temporarily replaces the .tp-groups area. pickerCollections: null =
    // metadata still loading, [] = user has no collections.
    const [pickerOpen, setPickerOpen] = useState(false);
    const [pickerCollections, setPickerCollections] = useState(null);
    // uid of the row being fetched/loaded into the session (brief per-row
    // loading state; all rows are disabled while one is in flight).
    const [pickerLoadingUid, setPickerLoadingUid] = useState(null);

    // Editable collection name: seeded from the AI-suggested state value, but
    // once the user touches the field their edits win over later AI updates.
    const [nameDraft, setNameDraft] = useState('');
    const nameTouchedRef = useRef(false);

    // Guards the slow initial read against clobbering a fresher storage change
    // (same pattern as useSmartOrganizeUndo).
    const loadedRef = useRef(false);
    // Tab uids seen on the previous groups render — a tab not in here flashes
    // in as new. null = no groups rendered yet (initial load doesn't flash).
    const prevTabUidsRef = useRef(null);
    const messagesRef = useRef(null);
    const textareaRef = useRef(null);
    const flashTimerRef = useRef(null);

    const messages = session?.messages || [];
    const groups = session?.groups || [];
    const isThinking = session?.status === 'thinking';
    // Set once the session is linked to a saved collection (after a save, or
    // after loading one via the picker) — Save becomes an in-place Update.
    const linkedUid = session?.linkedCollectionUid || null;
    const hasUserMessage = messages.some((m) => m.role === 'user');
    const totalTabs = useMemo(() => groups.reduce((n, g) => n + ((g.tabs || []).length), 0), [groups]);

    // ── Session subscription ────────────────────────────────────────────────
    useEffect(() => {
        let cancelled = false;

        const adopt = (state) => {
            loadedRef.current = true;
            setSession(state || null);
        };

        (async () => {
            try {
                // Single unconditional start: the SW reuses a fresh session,
                // replaces one past its 24h expiry, and heals a stale
                // 'thinking' turn — so the panel never needs a getState-then-
                // start dance (which would skip the SW's expiry/heal path).
                // The SW writes the session to storage before replying, so a
                // live onChanged usually adopts it first; the reply covers
                // environments without the event.
                const started = await browser.runtime.sendMessage({ type: 'taskPlannerStart' });
                if (cancelled || loadedRef.current) return;
                if (started && started.ok) adopt(started.state);
                else if (started && started.error) setActionError(started.error);
            } catch (e) {
                console.error('Task Planner: failed to load session', e);
                if (!cancelled) setActionError('Could not reach Tabox AI. Please try again.');
            }
        })();

        const onChanged = (changes, area) => {
            if (area !== 'local' || !changes[SESSION_KEY]) return;
            loadedRef.current = true;
            setSession(changes[SESSION_KEY].newValue || null);
        };
        browser.storage.onChanged.addListener(onChanged);
        return () => {
            cancelled = true;
            browser.storage.onChanged.removeListener(onChanged);
        };
    }, []);

    // Clear the flash timer on unmount.
    useEffect(() => () => {
        if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    }, []);

    // Pick a fresh thinking line each turn.
    useEffect(() => {
        if (isThinking) {
            setThinkingMsg(THINKING_MESSAGES[Math.floor(Math.random() * THINKING_MESSAGES.length)]);
        }
    }, [isThinking]);

    // Seed the name field from the AI suggestion until the user edits it.
    const aiName = session?.collectionName || '';
    useEffect(() => {
        if (!nameTouchedRef.current) setNameDraft(aiName);
    }, [aiName]);

    // Keep the transcript pinned to the latest message.
    useEffect(() => {
        const el = messagesRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [messages.length, isThinking]);

    // Reconcile the removed-tab collapse list + new-tab flash tracking whenever
    // the session's groups change.
    useEffect(() => {
        const uids = new Set();
        for (const g of groups) for (const t of (g.tabs || [])) uids.add(t.uid);
        prevTabUidsRef.current = uids;
        setRemovingTabs((prev) => (prev.length ? prev.filter((uid) => uids.has(uid)) : prev));
    }, [groups]);

    // Computed at render time against the PREVIOUS render's tab set (the effect
    // above updates the ref after paint), so newly-arrived tabs flash in once.
    const prevUids = prevTabUidsRef.current;
    const isNewTab = (uid) => prevUids !== null && !prevUids.has(uid);

    // ── Actions (all mutations run in the service worker) ───────────────────
    const sendText = useCallback(async (text) => {
        const trimmed = (text || '').trim();
        if (!trimmed || isThinking) return;
        setActionError(null);
        setInput('');
        if (textareaRef.current) textareaRef.current.style.height = 'auto';
        try {
            const res = await browser.runtime.sendMessage({ type: 'taskPlannerSend', payload: { text: trimmed } });
            if (res && res.ok === false && res.error) {
                setActionError(res.error);
            } else if (res && res.ignored) {
                // The SW acknowledged but did NOT append (a turn was already
                // thinking, or the text was empty server-side) — put the text
                // back in the composer instead of silently eating the message.
                setInput(trimmed);
            }
        } catch (e) {
            console.error('Task Planner: send failed', e);
            setActionError('Could not reach Tabox AI. Please try again.');
        }
    }, [isThinking]);

    const handleRemoveTab = useCallback(async (groupUid, tabUid) => {
        // Optimistic collapse; a failed removal must un-collapse the row, or the
        // tab stays hidden while it's still in the SW session (phantom removal).
        setRemovingTabs((prev) => (prev.includes(tabUid) ? prev : [...prev, tabUid]));
        try {
            const res = await browser.runtime.sendMessage({ type: 'taskPlannerRemoveTab', payload: { groupUid, tabUid } });
            if (!res || !res.ok) {
                setRemovingTabs((prev) => prev.filter((uid) => uid !== tabUid));
                setActionError((res && res.error) || 'Could not remove the tab.');
            }
        } catch (e) {
            console.error('Task Planner: remove tab failed', e);
            setRemovingTabs((prev) => prev.filter((uid) => uid !== tabUid));
            setActionError('Could not remove the tab.');
        }
    }, []);

    // Spin up a fresh batch of suggestion pills. The SW flips pills to null
    // (skeletons + spinning icon render from that) and lands the new batch via
    // storage.onChanged; the reply only carries failures worth surfacing.
    const handleRefreshPills = useCallback(async () => {
        setActionError(null);
        try {
            const res = await browser.runtime.sendMessage({ type: 'taskPlannerRefreshPills' });
            if (res && res.ok === false && res.error) setActionError(res.error);
        } catch (e) {
            console.error('Task Planner: pill refresh failed', e);
            setActionError('Could not fetch new ideas. Please try again.');
        }
    }, []);

    const resetLocal = useCallback(() => {
        nameTouchedRef.current = false;
        setNameDraft('');
        setInput('');
        setRemovingTabs([]);
        setPickerOpen(false);
        setPickerLoadingUid(null);
        prevTabUidsRef.current = null;
    }, []);

    const startFresh = useCallback(async () => {
        try {
            await browser.runtime.sendMessage({ type: 'taskPlannerReset' });
            const started = await browser.runtime.sendMessage({ type: 'taskPlannerStart', payload: { force: true } });
            if (started && started.ok) {
                loadedRef.current = true;
                setSession(started.state);
            } else if (started && started.error) {
                setActionError(started.error);
            }
        } catch (e) {
            console.error('Task Planner: reset failed', e);
            setActionError('Could not start a new plan. Please try again.');
        }
    }, []);

    const handleNewPlan = useCallback(async () => {
        if (saving) return;
        setActionError(null);
        resetLocal();
        await startFresh();
    }, [saving, resetLocal, startFresh]);

    // Save flow — build the collection from the session's groups and persist
    // it through updateRemoteData. The chat is NOT reset: the session stays
    // linked to the saved collection (taskPlannerMarkSaved / the existing
    // link), so the user keeps refining and re-saving in place.
    const handleSave = useCallback(async () => {
        if (saving || totalTabs === 0) return;
        setSaving(true);
        setActionError(null);
        try {
            const name = (nameDraft || aiName || 'Task Plan').trim() || 'Task Plan';
            const chromeGroups = groups.map((g, i) => ({ id: i + 1, title: g.title, color: g.color, collapsed: false }));
            const tabs = groups.flatMap((g, i) => (g.tabs || []).map((t) => ({
                url: t.url,
                title: t.title,
                favIconUrl: '',
                pinned: false,
                active: false,
                groupId: i + 1,
            })));
            const all = await loadAllCollections();
            // Linked session → update the collection IN PLACE (same uid, same
            // spot in the list). A linked-but-deleted collection falls through
            // to the create path below and re-links to the new uid.
            const existing = linkedUid ? all.find((c) => c.uid === linkedUid) : null;
            let flashUid;
            if (existing) {
                // applyUid wires tab.uid/group.uid/tab.groupUid so group counts
                // and future edits behave like any hand-saved collection.
                let updated = new TaboxCollection(name, tabs, chromeGroups);
                updated = applyUid(updated);
                // Preserve identity/metadata from the stored record — only the
                // name/tabs/groups come from the planner session.
                updated.uid = existing.uid;
                updated.parentId = existing.parentId ?? null;
                updated.color = existing.color;
                updated.createdOn = existing.createdOn;
                updated.order = existing.order;
                updated.isFavorite = existing.isFavorite;
                updated.favoriteOrder = existing.favoriteOrder;
                await updateRemoteData(all.map((c) => (c.uid === existing.uid ? updated : c)));
                showSuccessToast('Collection updated!');
                flashUid = existing.uid;
            } else {
                const collection = applyUid(new TaboxCollection(name, tabs, chromeGroups));
                await updateRemoteData([...all, collection]);
                showSuccessToast('Collection saved!');
                flashUid = collection.uid;
                // Link the session to the saved collection so the next save
                // updates it in place (storage.onChanged delivers the linked
                // state back). Best-effort: the save itself already succeeded.
                try {
                    await browser.runtime.sendMessage({
                        type: 'taskPlannerMarkSaved',
                        payload: { uid: collection.uid, name },
                    });
                } catch (linkError) {
                    console.error('Task Planner: mark-saved failed', linkError);
                }
            }
            if (typeof onDataUpdate === 'function') {
                Promise.resolve(onDataUpdate()).catch(() => {});
            }
            // AI flash on the collection card (aiProcessingUidsState drives
            // the shared .ai-processing-overlay on the list card).
            setAiProcessingUids((prev) => (prev.includes(flashUid) ? prev : [...prev, flashUid]));
            if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
            flashTimerRef.current = setTimeout(() => {
                setAiProcessingUids((prev) => prev.filter((uid) => uid !== flashUid));
            }, 2500);
        } catch (e) {
            console.error('Task Planner: save failed', e);
            setActionError('Could not save the collection. Please try again.');
        } finally {
            setSaving(false);
        }
    }, [saving, totalTabs, nameDraft, aiName, groups, linkedUid, updateRemoteData, onDataUpdate, setAiProcessingUids]);

    // ── Choose Collection (start from an existing collection) ───────────────
    const openPicker = useCallback(async () => {
        if (isThinking || saving) return;
        setActionError(null);
        setPickerOpen(true);
        setPickerCollections(null);
        try {
            const metas = await loadAllCollections({ metadataOnly: true });
            // Most recently touched first.
            const sorted = [...(metas || [])].sort((a, b) => (b.lastUpdated || 0) - (a.lastUpdated || 0));
            setPickerCollections(sorted);
        } catch (e) {
            console.error('Task Planner: could not list collections', e);
            setPickerCollections([]);
            setActionError('Could not load your collections. Please try again.');
        }
    }, [isThinking, saving]);

    const handlePick = useCallback(async (uid) => {
        if (pickerLoadingUid) return;
        setActionError(null);
        setPickerLoadingUid(uid);
        try {
            const full = await loadSingleCollection(uid);
            if (!full) {
                setActionError('Could not load that collection.');
                return;
            }
            const plannerGroups = plannerCore.collectionToPlannerGroups(full);
            const res = await browser.runtime.sendMessage({
                type: 'taskPlannerLoadCollection',
                payload: { uid, name: full.name, groups: plannerGroups },
            });
            if (!res || res.ok === false) {
                setActionError((res && res.error) || 'Could not load that collection.');
                return;
            }
            if (res.ignored) {
                // A turn is mid-flight in the SW — nothing was loaded.
                setActionError('Please wait for the current reply to finish.');
                return;
            }
            // Linked state renders via storage.onChanged (the SW also appends
            // an assistant bubble announcing the load).
            setPickerOpen(false);
        } catch (e) {
            console.error('Task Planner: load collection failed', e);
            setActionError('Could not load that collection.');
        } finally {
            setPickerLoadingUid(null);
        }
    }, [pickerLoadingUid]);

    // ── Composer ────────────────────────────────────────────────────────────
    const autogrow = () => {
        const el = textareaRef.current;
        if (!el) return;
        el.style.height = 'auto';
        // ~4 lines max (18px line-height + 16px vertical padding).
        el.style.height = `${Math.min(el.scrollHeight, 88)}px`;
    };

    const handleInputChange = (e) => {
        setInput(e.target.value);
        autogrow();
    };

    const handleKeyDown = (e) => {
        // IME composition: Enter confirms the composed text, not a send.
        if (e.nativeEvent.isComposing) return;
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendText(input);
        }
    };

    // Pills show until the first user message; null = still loading (render
    // skeletons), [] = generation failed with no fallback (render nothing).
    const pills = session?.pills;
    const showPills = !hasUserMessage && session !== null && (pills === null || (Array.isArray(pills) && pills.length > 0));

    return (
        <div className="tp-root">
            <div className="tp-layout">
                <div className="tp-chat">
                    <div className="tp-messages" ref={messagesRef}>
                        {session === null && !actionError && (
                            <div className="tp-msg tp-msg--assistant" aria-hidden="true">
                                <span className="tp-avatar">T</span>
                                <div className="tp-bubble tp-bubble--skeleton" />
                            </div>
                        )}
                        {session?.greeting && (
                            <div className="tp-msg tp-msg--assistant">
                                <span className="tp-avatar" aria-hidden="true">T</span>
                                <div className="tp-bubble">{session.greeting}</div>
                            </div>
                        )}
                        {messages.map((m, i) => (
                            <div
                                key={m.id}
                                className={`tp-msg ${m.role === 'user' ? 'tp-msg--user' : 'tp-msg--assistant'}`}
                                style={{ animationDelay: `${Math.min(i, 6) * 0.05}s` }}
                            >
                                {m.role === 'assistant' && <span className="tp-avatar" aria-hidden="true">T</span>}
                                <div className="tp-bubble">{m.content}</div>
                            </div>
                        ))}
                        {isThinking && (
                            <div className="tp-msg tp-msg--assistant" data-testid="tp-thinking">
                                <span className="tp-avatar" aria-hidden="true">T</span>
                                <div className="tp-bubble tp-thinking" role="status" aria-live="polite">
                                    <span className="tp-thinking-text">{thinkingMsg}</span>
                                    <span className="tp-thinking-dots" aria-hidden="true">
                                        <span className="tp-dot" />
                                        <span className="tp-dot" />
                                        <span className="tp-dot" />
                                    </span>
                                </div>
                            </div>
                        )}
                        {session?.status === 'error' && session.error && (
                            <div className="tp-msg tp-msg--assistant">
                                <span className="tp-avatar" aria-hidden="true">T</span>
                                <div className="tp-bubble tp-bubble--error">{session.error}</div>
                            </div>
                        )}
                    </div>

                    {showPills && (
                        <div className="tp-pills" data-testid="tp-pills">
                            {pills === null && [0, 1, 2].map((i) => (
                                <span key={i} className="tp-pill tp-pill--skeleton" data-testid="tp-pill-skeleton" aria-hidden="true" />
                            ))}
                            {Array.isArray(pills) && pills.map((pill, i) => (
                                <button
                                    key={pill}
                                    type="button"
                                    className="tp-pill"
                                    style={{ animationDelay: `${i * 0.06}s` }}
                                    onClick={() => sendText(pill)}
                                    disabled={isThinking}
                                >
                                    {pill}
                                </button>
                            ))}
                            <button
                                type="button"
                                className={`tp-pills-refresh${pills === null ? ' tp-pills-refresh--spinning' : ''}`}
                                aria-label="New ideas"
                                data-tooltip-id="main-tooltip"
                                data-tooltip-content="New ideas"
                                data-tooltip-class-name="small-tooltip"
                                // Disabled while a batch is already generating (it
                                // spins instead) or a turn is in flight.
                                disabled={pills === null || isThinking}
                                onClick={handleRefreshPills}
                            >
                                <MdRefresh size={15} />
                            </button>
                        </div>
                    )}

                    <div className="tp-composer">
                        <textarea
                            ref={textareaRef}
                            className="tp-input"
                            rows={1}
                            placeholder="Describe what you're planning…"
                            aria-label="Message Tabox AI"
                            maxLength={4000}
                            value={input}
                            onChange={handleInputChange}
                            onKeyDown={handleKeyDown}
                            disabled={isThinking || session === null}
                        />
                        <button
                            type="button"
                            className="tp-send-btn"
                            aria-label="Send message"
                            onClick={() => sendText(input)}
                            disabled={isThinking || session === null || !input.trim()}
                        >
                            <MdSend size={16} />
                        </button>
                    </div>
                </div>

                <div className="tp-tabs-panel">
                    <div className="tp-tabs-header">
                        <div className="tp-tabs-header-row">
                            <input
                                type="text"
                                className="tp-collection-name"
                                aria-label="Collection name"
                                placeholder="Collection name"
                                value={nameDraft}
                                onChange={(e) => {
                                    nameTouchedRef.current = true;
                                    setNameDraft(e.target.value);
                                }}
                            />
                            {!linkedUid && (
                                <button
                                    type="button"
                                    className="tp-choose-btn"
                                    aria-label="Start from a collection"
                                    data-tooltip-id="main-tooltip"
                                    data-tooltip-content="Start from a collection"
                                    data-tooltip-class-name="small-tooltip"
                                    disabled={isThinking || saving}
                                    onClick={openPicker}
                                >
                                    <MdFolderOpen size={16} />
                                </button>
                            )}
                        </div>
                        <span className="tp-tab-count">{totalTabs} tab{totalTabs === 1 ? '' : 's'}</span>
                    </div>
                    {pickerOpen ? (
                        <div className="tp-picker" data-testid="tp-picker">
                            <div className="tp-picker-header">
                                <span className="tp-picker-title">Choose a collection</span>
                                <button
                                    type="button"
                                    className="tp-picker-close"
                                    aria-label="Close collection picker"
                                    onClick={() => setPickerOpen(false)}
                                >
                                    <MdClose size={14} />
                                </button>
                            </div>
                            <div className="tp-picker-list">
                                {pickerCollections === null && (
                                    <p className="tp-groups-empty">Loading your collections…</p>
                                )}
                                {Array.isArray(pickerCollections) && pickerCollections.length === 0 && (
                                    <p className="tp-groups-empty">No saved collections yet.</p>
                                )}
                                {Array.isArray(pickerCollections) && pickerCollections.map((c) => (
                                    <button
                                        type="button"
                                        key={c.uid}
                                        className={`tp-picker-row${pickerLoadingUid === c.uid ? ' tp-picker-row--loading' : ''}`}
                                        disabled={!!pickerLoadingUid}
                                        onClick={() => handlePick(c.uid)}
                                    >
                                        <span className="tp-picker-row-name">{c.name}</span>
                                        <span className="tp-picker-row-count">
                                            {pickerLoadingUid === c.uid
                                                ? 'Loading…'
                                                : `${c.tabCount || 0} tab${(c.tabCount || 0) === 1 ? '' : 's'}`}
                                        </span>
                                    </button>
                                ))}
                            </div>
                        </div>
                    ) : (
                    <div className="tp-groups">
                        {groups.length === 0 && (
                            <>
                                <p className="tp-groups-empty">Websites the AI gathers for your plan will appear here.</p>
                                {!linkedUid && (
                                    <button
                                        type="button"
                                        className="tp-choose-link"
                                        disabled={isThinking || saving}
                                        onClick={openPicker}
                                    >
                                        Start from a collection
                                    </button>
                                )}
                            </>
                        )}
                        {groups.map((g, gi) => (
                            <div
                                key={g.uid}
                                className="tp-group"
                                style={{ borderLeftColor: getColorCode(g.color), animationDelay: `${Math.min(gi, 6) * 0.07}s` }}
                            >
                                <div className="tp-group-title">{g.title}</div>
                                <ul className="tp-group-tabs">
                                    {(g.tabs || []).map((t) => (
                                        <li
                                            key={t.uid}
                                            className={`tp-tab${isNewTab(t.uid) ? ' tp-tab--new' : ''}${removingTabs.includes(t.uid) ? ' tp-tab--removing' : ''}`}
                                        >
                                            <img
                                                className="tp-tab-favicon"
                                                src={faviconFor(t.url)}
                                                alt=""
                                                onError={handleFaviconError}
                                            />
                                            <span className="tp-tab-title">{t.title || t.url}</span>
                                            <button
                                                type="button"
                                                className="tp-tab-remove"
                                                aria-label="Remove tab"
                                                data-tooltip-id="main-tooltip"
                                                data-tooltip-content="Remove tab"
                                                data-tooltip-class-name="small-tooltip"
                                                // Disabled mid-turn: the AI reply lands the full tab set
                                                // computed from the pre-removal snapshot, which would
                                                // silently resurrect a tab removed while it was thinking.
                                                disabled={isThinking}
                                                onClick={() => handleRemoveTab(g.uid, t.uid)}
                                            >
                                                <MdClose size={14} />
                                            </button>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        ))}
                    </div>
                    )}
                    <div className="tp-tabs-footer">
                        {actionError && <div className="tp-error">{actionError}</div>}
                        <button
                            type="button"
                            className="ai-tool-action-btn tp-save-btn"
                            onClick={handleSave}
                            // Locked mid-turn (the AI reply would land after saving a
                            // stale set) and while removals are pending (the removed
                            // tabs aren't out of the SW session yet).
                            disabled={totalTabs === 0 || saving || isThinking || removingTabs.length > 0}
                        >
                            <BsStars size={14} style={{ marginRight: '6px' }} />
                            {saving ? 'Saving…' : (linkedUid ? 'Update collection' : 'Save collection')}
                        </button>
                        <button
                            type="button"
                            className="tp-new-plan-btn"
                            onClick={handleNewPlan}
                            disabled={saving}
                        >
                            New plan
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}

export default TaskPlannerPanel;
