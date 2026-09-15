import { buildHubSuggestions } from '../app/ai/AIHubSuggestions';

const collection = (uid, n) => ({ uid, name: uid, tabs: Array.from({ length: n }, (_, i) => ({ url: `https://${uid}.example/${i}` })) });
const messy = [collection('Big', 40), collection('Untitled', 2)];

test('a planning session only suggests refinements of the current plan', () => {
    const out = buildHubSuggestions({ collections: messy, activeTool: 'task-planner', followUps: ['Add more attractions', 'Find more hotel options'] });
    expect(out.map(s => s.label)).toEqual(['Add more attractions', 'Find more hotel options']);
    expect(out.some(s => s.tool)).toBe(false);
});

test('a planning session without AI follow-ups falls back to generic plan refinements, never maintenance', () => {
    const out = buildHubSuggestions({ collections: messy, activeTool: 'task-planner', followUps: [] });
    expect(out.map(s => s.label)).toEqual(['Find more useful resources', 'Focus on beginner-friendly resources']);
});

test('a library-maintenance session suggests neighbouring maintenance actions, not trip ideas or the active tool', () => {
    const out = buildHubSuggestions({ collections: messy, activeTool: 'auto-arrange-folders', followUps: ['Plan a Japan trip'] });
    const tools = out.map(s => s.tool);
    expect(tools).toEqual(expect.arrayContaining(['split-collection', 'auto-rename', 'smart-organize']));
    expect(tools).not.toContain('auto-arrange-folders');
    expect(out.map(s => s.label)).not.toContain('Plan a Japan trip');
    expect(out.map(s => s.label)).not.toContain('Plan something new');
});

test('a tidy library still offers something after a maintenance action', () => {
    expect(buildHubSuggestions({ collections: [], activeTool: 'smart-organize' }).map(s => s.label)).toEqual(['Plan something new']);
});

test('a conversational turn (clarify) shows the AI follow-ups for that reply, never maintenance chores', () => {
    const out = buildHubSuggestions({ collections: messy, activeTool: 'clarify', followUps: ['Build on Austria Winter Travel', 'Plan a brand new trip'] });
    expect(out.map(s => s.label)).toEqual(['Build on Austria Winter Travel', 'Plan a brand new trip']);
    expect(out.some(s => s.tool)).toBe(false);
});

test('a conversational turn without follow-ups shows nothing rather than off-topic maintenance', () => {
    expect(buildHubSuggestions({ collections: messy, activeTool: 'clarify', followUps: [] })).toEqual([]);
    expect(buildHubSuggestions({ collections: messy, activeTool: 'find-tab', followUps: [] })).toEqual([]);
});
