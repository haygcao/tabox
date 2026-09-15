const hub = require('../chrome/ai-hub-core');

const collection = (uid, count, parentId = null) => ({ uid, name: uid, parentId, tabs: Array.from({ length: count }, (_, i) => ({ url: `https://${uid}.example/${i}` })) });

test('suggests real oversized collections and a backlog of loose collections', () => {
    const collections = [collection('Research', 42), ...Array.from({ length: 5 }, (_, i) => collection(`c${i}`, 2))];
    const suggestions = hub.buildSuggestions(collections);
    expect(suggestions).toEqual(expect.arrayContaining([
        expect.objectContaining({ tool: 'split-collection', uids: ['Research'], label: expect.stringContaining('42') }),
        expect.objectContaining({ tool: 'auto-arrange-folders', label: expect.stringContaining('6') }),
    ]));
    expect(hub.buildSuggestions(collections.map(c => ({ ...c, parentId: 'folder' })))).not.toEqual(expect.arrayContaining([expect.objectContaining({ tool: 'auto-arrange-folders' })]));
});

test('suggestions follow the selection and disappear when their trigger is resolved', () => {
    expect(hub.buildSuggestions([collection('Large', 40), collection('Small', 2)], { type: 'selected', uids: ['Small'] })).not.toEqual(expect.arrayContaining([expect.objectContaining({ tool: 'split-collection' })]));
    expect(hub.buildSuggestions([collection('Small', 2)])).not.toEqual(expect.arrayContaining([expect.objectContaining({ tool: 'split-collection' })]));
});

test('duplicate suggestions require evidence and never claim every duplicate is safe to delete', () => {
    const a = collection('a', 3);
    expect(hub.buildSuggestions([a])).not.toEqual(expect.arrayContaining([expect.objectContaining({ tool: 'duplicate-sweep' })]));
    expect(hub.buildSuggestions([a, { ...collection('b', 1), tabs: [a.tabs[0]] }])).toEqual(expect.arrayContaining([expect.objectContaining({ tool: 'duplicate-sweep' })]));
});

test('validates routes against live collections and selected scope', () => {
    const collections = [collection('allowed', 40), collection('outside', 40)];
    expect(() => hub.normalizeRoute({ tool: 'delete-all', uids: [], reply: 'ok' }, collections)).toThrow();
    expect(() => hub.normalizeRoute({ tool: 'split-collection', uids: ['missing'], reply: 'ok' }, collections)).toThrow();
    expect(() => hub.normalizeRoute({ tool: 'auto-rename', uids: ['outside'], reply: 'ok' }, collections, { type: 'selected', uids: ['allowed'] })).toThrow();
    expect(hub.normalizeRoute({ tool: 'split-collection', uids: ['allowed'], reply: 'Review first.' }, collections).uids).toEqual(['allowed']);
});

describe('find-tab', () => {
    const library = [
        { uid: 'work', name: 'Work', tabs: [
            { url: 'https://docs.google.com/document/d/1', title: 'Interview notes - Dima Aluf', favIconUrl: 'https://docs.google.com/favicon.ico' },
            { url: 'https://docs.google.com/document/d/2', title: 'Interview notes - Someone Else' },
        ] },
        { uid: 'fun', name: 'Fun', tabs: [{ url: 'https://example.com/aluf-recipes', title: 'Recipes' }] },
    ];

    test('searchTabs ranks tabs matching every keyword first and includes collection info', () => {
        const results = hub.searchTabs(library, 'interview notes dima aluf');
        expect(results[0]).toEqual({ collectionUid: 'work', collectionName: 'Work', title: 'Interview notes - Dima Aluf', url: 'https://docs.google.com/document/d/1', favIconUrl: 'https://docs.google.com/favicon.ico' });
        expect(results.map(r => r.url)).toEqual([
            'https://docs.google.com/document/d/1',
            'https://docs.google.com/document/d/2',
            'https://example.com/aluf-recipes',
        ]);
    });

    test('searchTabs matches urls, is case-insensitive, respects scope and caps results', () => {
        expect(hub.searchTabs(library, 'ALUF-RECIPES').map(r => r.url)).toEqual(['https://example.com/aluf-recipes']);
        expect(hub.searchTabs(library, 'aluf', { type: 'selected', uids: ['fun'] }).map(r => r.collectionUid)).toEqual(['fun']);
        expect(hub.searchTabs(library, 'nothing-here')).toEqual([]);
        expect(hub.searchTabs(library, '')).toEqual([]);
        const many = [{ uid: 'c', name: 'C', tabs: Array.from({ length: 30 }, (_, i) => ({ url: `https://x.com/${i}`, title: `Note ${i}` })) }];
        expect(hub.searchTabs(many, 'note')).toHaveLength(hub.MAX_TAB_RESULTS);
    });

    test('searchTabs prefers title matches over url-only matches when keyword hits tie', () => {
        const tabs = [{ uid: 'c', name: 'C', tabs: [
            { url: 'https://x.com/7', title: 'Resource 8' },
            { url: 'https://x.com/6', title: 'Resource 7' },
        ] }];
        expect(hub.searchTabs(tabs, 'resource 7').map(r => r.title)).toEqual(['Resource 7', 'Resource 8']);
    });

    test('normalizeRoute accepts find-tab with a trimmed query and asks for one when it is missing', () => {
        expect(hub.normalizeRoute({ tool: 'find-tab', uids: [], reply: 'Looking…', query: '  Dima Aluf ' }, library)).toMatchObject({ tool: 'find-tab', query: 'Dima Aluf' });
        const empty = hub.normalizeRoute({ tool: 'find-tab', uids: [], reply: '', query: '' }, library);
        expect(empty.query).toBe('');
        expect(empty.reply).toMatch(/which tab/i);
        expect(hub.normalizeRoute({ tool: 'clarify', uids: [], reply: 'ok' }, library)).not.toHaveProperty('query');
    });

    test('route schema and prompt advertise find-tab', () => {
        expect(hub.ROUTE_SCHEMA.properties.query).toEqual({ type: 'string' });
        expect(hub.ROUTE_SCHEMA.required).toContain('query');
        expect(hub.buildRoutePrompt(library, { type: 'all' })).toMatch(/find-tab/);
    });
});

describe('conversational follow-ups', () => {
    const library = [{ uid: 'c', name: 'C', tabs: [] }];
    test('route schema requires followUps and the prompt asks for them on conversational replies', () => {
        expect(hub.ROUTE_SCHEMA.properties.followUps).toMatchObject({ type: 'array' });
        expect(hub.ROUTE_SCHEMA.required).toContain('followUps');
        expect(hub.buildRoutePrompt(library, { type: 'all' })).toMatch(/followUps/);
    });
    test('normalizeRoute keeps sanitized follow-ups for clarify and find-tab only', () => {
        const route = hub.normalizeRoute({ tool: 'clarify', uids: [], reply: 'Which trip?', query: '', followUps: ['  Build on Austria Winter Travel ', '', 42, 'Plan a brand new trip', 'x'.repeat(80), 'fourth', 'fifth'] }, library);
        expect(route.followUps).toEqual(['Build on Austria Winter Travel', 'Plan a brand new trip', 'x'.repeat(30)]);
        expect(hub.normalizeRoute({ tool: 'find-tab', uids: [], reply: 'ok', query: 'notes', followUps: ['Search all collections'] }, library).followUps).toEqual(['Search all collections']);
        expect(hub.normalizeRoute({ tool: 'auto-rename', uids: [], reply: 'ok', followUps: ['Plan a trip'] }, library).followUps).toEqual([]);
        expect(hub.normalizeRoute({ tool: 'clarify', uids: [], reply: 'ok' }, library).followUps).toEqual([]);
    });
});
