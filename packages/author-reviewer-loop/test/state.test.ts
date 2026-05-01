import { describe, expect, it } from 'vitest';
import { PaneStatus, initialState, reduce } from '../lib/engine/state.mjs';

describe('author-reviewer-loop state reducer', () => {
  it('tolerates partial turn snapshots from runtimes', () => {
    const state = reduce(initialState(), {
      type: 'turnSnapshot',
      round: 1,
      role: 'AUTHOR',
      snapshot: {
        status: 'completed',
        usage: { inputTokens: 1 },
      },
    });

    const pane = state.rounds.get(1)?.AUTHOR;
    expect(pane?.status).toBe(PaneStatus.Completed);
    expect(pane?.lines).toEqual([]);
    expect(pane?.current).toBe('');
    expect(pane?.tools).toEqual([]);
    expect(pane?.chars).toBe(0);
  });

  it('normalizes missing tool character counts instead of producing NaN', () => {
    const state = reduce(initialState(), {
      type: 'turnSnapshot',
      round: 1,
      role: 'REVIEWER',
      snapshot: {
        text: 'APPROVED',
        status: 'completed',
        tools: [
          { id: 'tool-1', tag: '#1', name: 'shell', title: 'Shell' },
          { id: 'tool-2', tag: '#2', name: 'read', outputChars: 42 },
        ],
      },
    });

    const tools = state.rounds.get(1)?.REVIEWER.tools ?? [];
    expect(tools.map((tool) => tool.chars)).toEqual([0, 42]);
  });

  it('marks reviewer approval as pending and actionable before the final result is emitted', () => {
    const result = {
      approved: true,
      rounds: 1,
      maxRounds: 2,
      feedback: 'APPROVED\nNo remaining issues.',
      cwd: process.cwd(),
    };
    const state = reduce(initialState(), { type: 'approvalPending', result });

    expect(state.phase).toBe('done');
    expect(state.result).toBe(result);
    expect(state.approvalPending).toBe(true);
    expect(state.finishedAt).toEqual(expect.any(Number));

    const finalState = reduce(state, { type: 'result', result });
    expect(finalState.approvalPending).toBe(false);
  });

  it('clears pending approval immediately when the user force-continues', () => {
    const result = {
      approved: true,
      rounds: 1,
      maxRounds: 2,
      feedback: 'APPROVED\nNo remaining issues.',
      cwd: process.cwd(),
    };
    const pending = reduce(initialState(), { type: 'approvalPending', result });
    const continued = reduce(pending, { type: 'approvalContinued', round: 1, feedback: 'force another round' });

    expect(continued.phase).toBe('running');
    expect(continued.result).toBeNull();
    expect(continued.approvalPending).toBe(false);
    expect(continued.finishedAt).toBeNull();
    expect(continued.statuses).toMatchObject({ AUTHOR: PaneStatus.Pending, REVIEWER: PaneStatus.Pending });
  });

  it('keeps tool events without ids separate instead of merging them together', () => {
    let state = initialState();
    state = reduce(state, {
      type: 'toolStart',
      flowId: 1,
      round: 1,
      role: 'AUTHOR',
      status: PaneStatus.Running,
      name: 'shell',
      title: 'First tool',
    });
    state = reduce(state, {
      type: 'toolStart',
      flowId: 2,
      round: 1,
      role: 'AUTHOR',
      status: PaneStatus.Running,
      name: 'read',
      title: 'Second tool',
    });

    const pane = state.rounds.get(1)?.AUTHOR;
    expect(pane?.tools.map((tool) => tool.id)).toEqual(['tool-event-1', 'tool-event-2']);
    expect(pane?.flow.filter((item) => item.kind === 'tool').map((item) => item.title)).toEqual([
      'First tool',
      'Second tool',
    ]);
  });

  it('merges same reasoning stream and separates different reasoning streams', () => {
    let state = initialState();
    state = reduce(state, { type: 'reasoningDelta', flowId: 1, reasoningId: 'r1', round: 1, role: 'AUTHOR', delta: 'Plan first. ' });
    state = reduce(state, { type: 'reasoningDelta', flowId: 2, reasoningId: 'r1', round: 1, role: 'AUTHOR', delta: 'Then patch.' });
    state = reduce(state, { type: 'reasoningDelta', flowId: 3, reasoningId: 'r2', round: 1, role: 'AUTHOR', delta: 'Check result.' });
    state = reduce(state, { type: 'delta', flowId: 4, round: 1, role: 'AUTHOR', delta: 'Done.' });

    expect(state.rounds.get(1)?.AUTHOR.flow).toEqual([
      { id: 'flow-r1', sourceId: 'r1', kind: 'reasoning', text: 'Plan first. Then patch.' },
      { id: 'flow-r2', sourceId: 'r2', kind: 'reasoning', text: 'Check result.' },
      { id: 'flow-4', sourceId: 4, kind: 'text', text: 'Done.' },
    ]);
  });

  it('deduplicates cumulative reasoning chunks and repairs plain-word boundaries', () => {
    let state = initialState();
    state = reduce(state, { type: 'reasoningDelta', flowId: 1, reasoningId: 'r1', round: 1, role: 'AUTHOR', delta: 'Plan' });
    state = reduce(state, { type: 'reasoningDelta', flowId: 2, reasoningId: 'r1', round: 1, role: 'AUTHOR', delta: 'Plan first' });
    state = reduce(state, { type: 'reasoningDelta', flowId: 3, reasoningId: 'r1', round: 1, role: 'AUTHOR', delta: ' then patch' });
    state = reduce(state, { type: 'reasoningDelta', flowId: 4, reasoningId: 'r1', round: 1, role: 'AUTHOR', delta: 'files' });

    const pane = state.rounds.get(1)?.AUTHOR;
    expect(pane?.flow[0]).toMatchObject({ kind: 'reasoning', text: 'Plan first then patch files' });
    expect(pane?.reasoning.blocks[0]).toMatchObject({ content: 'Plan first then patch files', charCount: 'Plan first then patch files'.length });
    expect(pane?.reasoning.totalChars).toBe('Plan first then patch files'.length);
  });

  it('does not inject spaces when consecutive deltas split a word mid-token', () => {
    let state = initialState();
    state = reduce(state, { type: 'delta', flowId: 1, round: 1, role: 'AUTHOR', delta: 'Hello wor' });
    state = reduce(state, { type: 'delta', flowId: 2, round: 1, role: 'AUTHOR', delta: 'ld' });
    state = reduce(state, { type: 'reasoningDelta', flowId: 3, reasoningId: 'r1', round: 1, role: 'AUTHOR', delta: 'comp' });
    state = reduce(state, { type: 'reasoningDelta', flowId: 4, reasoningId: 'r1', round: 1, role: 'AUTHOR', delta: 'lete' });

    const pane = state.rounds.get(1)?.AUTHOR;
    expect(pane?.flow).toEqual([
      { id: 'flow-1', sourceId: 1, kind: 'text', text: 'Hello world' },
      { id: 'flow-r1', sourceId: 'r1', kind: 'reasoning', text: 'complete' },
    ]);
    expect(pane?.reasoning.blocks[0]).toMatchObject({ content: 'complete', charCount: 'complete'.length });
  });

  it('does not inject spaces when longer words are split across streaming chunks', () => {
    let state = initialState();
    state = reduce(state, { type: 'delta', flowId: 1, round: 1, role: 'AUTHOR', delta: 'implementa' });
    state = reduce(state, { type: 'delta', flowId: 2, round: 1, role: 'AUTHOR', delta: 'tion details' });
    state = reduce(state, { type: 'reasoningDelta', flowId: 3, reasoningId: 'r1', round: 1, role: 'AUTHOR', delta: 'distribu' });
    state = reduce(state, { type: 'reasoningDelta', flowId: 4, reasoningId: 'r1', round: 1, role: 'AUTHOR', delta: 'tion plan' });

    const pane = state.rounds.get(1)?.AUTHOR;
    expect(pane?.flow).toEqual([
      { id: 'flow-1', sourceId: 1, kind: 'text', text: 'implementation details' },
      { id: 'flow-r1', sourceId: 'r1', kind: 'reasoning', text: 'distribution plan' },
    ]);
    expect(pane?.reasoning.blocks[0]).toMatchObject({
      content: 'distribution plan',
      charCount: 'distribution plan'.length,
    });
  });


  it('does not inject spaces when chunks split common prefixes from the rest of a word', () => {
    let state = initialState();
    state = reduce(state, { type: 'delta', flowId: 1, round: 1, role: 'AUTHOR', delta: 'un' });
    state = reduce(state, { type: 'delta', flowId: 2, round: 1, role: 'AUTHOR', delta: 'reasonable output' });
    state = reduce(state, { type: 'reasoningDelta', flowId: 3, reasoningId: 'r1', round: 1, role: 'AUTHOR', delta: 'inter' });
    state = reduce(state, { type: 'reasoningDelta', flowId: 4, reasoningId: 'r1', round: 1, role: 'AUTHOR', delta: 'face changes' });

    const pane = state.rounds.get(1)?.AUTHOR;
    expect(pane?.flow).toEqual([
      { id: 'flow-1', sourceId: 1, kind: 'text', text: 'unreasonable output' },
      { id: 'flow-r1', sourceId: 'r1', kind: 'reasoning', text: 'interface changes' },
    ]);
    expect(pane?.reasoning.blocks[0]).toMatchObject({
      content: 'interface changes',
      charCount: 'interface changes'.length,
    });
  });

  it('does not inject spaces when chunks split longer prefixes from the rest of a word', () => {
    let state = initialState();
    state = reduce(state, { type: 'delta', flowId: 1, round: 1, role: 'AUTHOR', delta: 'pre' });
    state = reduce(state, { type: 'delta', flowId: 2, round: 1, role: 'AUTHOR', delta: 'determined output' });
    state = reduce(state, { type: 'reasoningDelta', flowId: 3, reasoningId: 'r1', round: 1, role: 'AUTHOR', delta: 'anti' });
    state = reduce(state, { type: 'reasoningDelta', flowId: 4, reasoningId: 'r1', round: 1, role: 'AUTHOR', delta: 'virus checks' });

    const pane = state.rounds.get(1)?.AUTHOR;
    expect(pane?.flow).toEqual([
      { id: 'flow-1', sourceId: 1, kind: 'text', text: 'predetermined output' },
      { id: 'flow-r1', sourceId: 'r1', kind: 'reasoning', text: 'antivirus checks' },
    ]);
    expect(pane?.reasoning.blocks[0]).toMatchObject({
      content: 'antivirus checks',
      charCount: 'antivirus checks'.length,
    });
  });
  it('does not inject spaces into common continuous words split across short chunks', () => {
    let state = initialState();
    state = reduce(state, { type: 'delta', flowId: 1, round: 1, role: 'AUTHOR', delta: 'sub' });
    state = reduce(state, { type: 'delta', flowId: 2, round: 1, role: 'AUTHOR', delta: 'process' });
    state = reduce(state, { type: 'reasoningDelta', flowId: 3, reasoningId: 'r1', round: 1, role: 'AUTHOR', delta: 're' });
    state = reduce(state, { type: 'reasoningDelta', flowId: 4, reasoningId: 'r1', round: 1, role: 'AUTHOR', delta: 'viewer' });

    const pane = state.rounds.get(1)?.AUTHOR;
    expect(pane?.flow).toEqual([
      { id: 'flow-1', sourceId: 1, kind: 'text', text: 'subprocess' },
      { id: 'flow-r1', sourceId: 'r1', kind: 'reasoning', text: 'reviewer' },
    ]);
  });

  it('does not inject spaces into common technical words split across chunks', () => {
    let state = initialState();
    state = reduce(state, { type: 'delta', flowId: 1, round: 1, role: 'AUTHOR', delta: 'webs' });
    state = reduce(state, { type: 'delta', flowId: 2, round: 1, role: 'AUTHOR', delta: 'ocket server' });
    state = reduce(state, { type: 'reasoningDelta', flowId: 3, reasoningId: 'r1', round: 1, role: 'AUTHOR', delta: 'middle' });
    state = reduce(state, { type: 'reasoningDelta', flowId: 4, reasoningId: 'r1', round: 1, role: 'AUTHOR', delta: 'ware stack' });

    const pane = state.rounds.get(1)?.AUTHOR;
    expect(pane?.flow).toEqual([
      { id: 'flow-1', sourceId: 1, kind: 'text', text: 'websocket server' },
      { id: 'flow-r1', sourceId: 'r1', kind: 'reasoning', text: 'middleware stack' },
    ]);
  });

  it('keeps separate whole-word stream chunks spaced apart', () => {
    let state = initialState();
    state = reduce(state, { type: 'delta', flowId: 1, round: 1, role: 'AUTHOR', delta: 'patch' });
    state = reduce(state, { type: 'delta', flowId: 2, round: 1, role: 'AUTHOR', delta: 'files' });
    state = reduce(state, { type: 'reasoningDelta', flowId: 3, reasoningId: 'r1', round: 1, role: 'AUTHOR', delta: 'latest' });
    state = reduce(state, { type: 'reasoningDelta', flowId: 4, reasoningId: 'r1', round: 1, role: 'AUTHOR', delta: 'tool' });

    const pane = state.rounds.get(1)?.AUTHOR;
    expect(pane?.flow).toEqual([
      { id: 'flow-1', sourceId: 1, kind: 'text', text: 'patch files' },
      { id: 'flow-r1', sourceId: 'r1', kind: 'reasoning', text: 'latest tool' },
    ]);
    expect(pane?.reasoning.blocks[0]).toMatchObject({
      content: 'latest tool',
      charCount: 'latest tool'.length,
    });
  });

  it('keeps short adjacent word chunks spaced apart', () => {
    let state = initialState();
    state = reduce(state, { type: 'delta', flowId: 1, round: 1, role: 'AUTHOR', delta: 'run' });
    state = reduce(state, { type: 'delta', flowId: 2, round: 1, role: 'AUTHOR', delta: 'tests' });
    state = reduce(state, { type: 'reasoningDelta', flowId: 3, reasoningId: 'r1', round: 1, role: 'AUTHOR', delta: 'fix' });
    state = reduce(state, { type: 'reasoningDelta', flowId: 4, reasoningId: 'r1', round: 1, role: 'AUTHOR', delta: 'api' });

    const pane = state.rounds.get(1)?.AUTHOR;
    expect(pane?.flow).toEqual([
      { id: 'flow-1', sourceId: 1, kind: 'text', text: 'run tests' },
      { id: 'flow-r1', sourceId: 'r1', kind: 'reasoning', text: 'fix api' },
    ]);
  });

  it('deduplicates overlapping reasoning chunks', () => {
    let state = initialState();
    state = reduce(state, { type: 'reasoningDelta', flowId: 1, reasoningId: 'r1', round: 1, role: 'AUTHOR', delta: 'read package' });
    state = reduce(state, { type: 'reasoningDelta', flowId: 2, reasoningId: 'r1', round: 1, role: 'AUTHOR', delta: 'package json' });

    expect(state.rounds.get(1)?.AUTHOR.flow[0]).toMatchObject({ text: 'read package json' });
    expect(state.rounds.get(1)?.AUTHOR.reasoning.blocks[0]).toMatchObject({ content: 'read package json' });
  });

  it('keeps non-contiguous reasoning fragments separate in inline flow', () => {
    let state = initialState();
    state = reduce(state, { type: 'reasoningDelta', flowId: 1, reasoningId: 'r1', round: 1, role: 'AUTHOR', delta: 'Plan first.' });
    state = reduce(state, { type: 'delta', flowId: 2, round: 1, role: 'AUTHOR', delta: 'Visible answer.' });
    state = reduce(state, { type: 'toolStart', flowId: 3, round: 1, role: 'AUTHOR', toolCallId: 'tool-1', status: PaneStatus.Running, title: 'Read file' });
    state = reduce(state, { type: 'reasoningDelta', flowId: 4, reasoningId: 'r1', round: 1, role: 'AUTHOR', delta: 'Check result.' });
    state = reduce(state, { type: 'reasoningCompleted', round: 1, role: 'AUTHOR', reasoningId: 'r1', content: 'Plan first. Check result.' });

    const pane = state.rounds.get(1)?.AUTHOR;
    expect(pane?.flow.map((item) => item.kind)).toEqual(['reasoning', 'text', 'tool', 'reasoning']);
    expect(pane?.flow.filter((item) => item.kind === 'reasoning').map((item) => item.text)).toEqual(['Plan first.', 'Check result.']);
    expect(pane?.flow.map((item) => item.id)).toEqual(['flow-r1', 'flow-2', 'flow-3', 'flow-r1-4']);
    expect(pane?.reasoning.blocks).toHaveLength(1);
    expect(pane?.reasoning.blocks[0]).toMatchObject({ id: 'r1', content: 'Plan first. Check result.', completed: true });
  });
  it('updates a live tool call from tool.update without adding a new row', () => {
    let state = initialState();
    state = reduce(state, { type: 'toolStart', flowId: 1, round: 1, role: 'REVIEWER', toolCallId: 'tool-1', status: PaneStatus.Running, name: 'shell', title: 'Run command' });
    state = reduce(state, { type: 'toolUpdate', flowId: 2, round: 1, role: 'REVIEWER', toolCallId: 'tool-1', status: 'running', output: 'partial output', chars: 14 });

    const pane = state.rounds.get(1)?.REVIEWER;
    expect(pane?.flow.filter((item) => item.kind === 'tool')).toHaveLength(1);
    expect(pane?.tools[0]).toMatchObject({ id: 'tool-1', status: 'running', output: 'partial output', chars: 14 });
  });

  it('merges id-less tool lifecycle events with the same normalized title', () => {
    let state = initialState();
    state = reduce(state, { type: 'toolStart', flowId: 1, round: 1, role: 'REVIEWER', status: PaneStatus.Running, name: 'Read', title: 'Read file: package.json' });
    state = reduce(state, { type: 'toolEnd', flowId: 2, round: 1, role: 'REVIEWER', status: 'completed', title: '  Read   file: package.json  ', output: 'ok', chars: 2 });

    const pane = state.rounds.get(1)?.REVIEWER;
    expect(pane?.flow.filter((item) => item.kind === 'tool')).toHaveLength(1);
    expect(pane?.tools).toHaveLength(1);
    expect(pane?.tools[0]).toMatchObject({ status: 'completed', output: 'ok', chars: 2 });
  });

  it('keeps repeated id-less tool starts separate even when titles match', () => {
    let state = initialState();
    state = reduce(state, { type: 'toolStart', flowId: 1, round: 1, role: 'AUTHOR', status: PaneStatus.Running, name: 'Read', title: 'Read file: package.json' });
    state = reduce(state, { type: 'toolEnd', flowId: 2, round: 1, role: 'AUTHOR', status: 'completed', name: 'Read', title: 'Read file: package.json' });
    state = reduce(state, { type: 'toolStart', flowId: 3, round: 1, role: 'AUTHOR', status: PaneStatus.Running, name: 'Read', title: 'Read file: package.json' });

    const pane = state.rounds.get(1)?.AUTHOR;
    expect(pane?.tools.map((tool) => tool.id)).toEqual(['tool-event-1', 'tool-event-3']);
    expect(pane?.flow.filter((item) => item.kind === 'tool')).toHaveLength(2);
  });

  it('avoids synthetic tool id collisions when later id-less events follow flow-based ids', () => {
    let state = initialState();
    state = reduce(state, { type: 'delta', flowId: 1, round: 1, role: 'AUTHOR', delta: 'working' });
    state = reduce(state, { type: 'toolStart', flowId: 2, round: 1, role: 'AUTHOR', status: PaneStatus.Running, title: 'First synthetic tool' });
    state = reduce(state, { type: 'toolStart', round: 1, role: 'AUTHOR', status: PaneStatus.Running, title: 'Second synthetic tool without flow id' });

    const pane = state.rounds.get(1)?.AUTHOR;
    expect(pane?.tools.map((tool) => tool.id)).toEqual(['tool-event-2', 'tool-event-3']);
    expect(new Set(pane?.tools.map((tool) => tool.id)).size).toBe(2);
  });

  it('records per-role turn duration', () => {
    let state = initialState();
    state = reduce(state, { type: 'turnStart', round: 1, role: 'AUTHOR', at: 1000 });
    state = reduce(state, { type: 'turnCompleted', round: 1, role: 'AUTHOR', at: 2450, stopReason: 'end_turn' });

    expect(state.rounds.get(1)?.AUTHOR).toMatchObject({
      status: PaneStatus.Completed,
      startedAt: 1000,
      finishedAt: 2450,
      durationMs: 1450,
      stopReason: 'end_turn',
    });
  });

  it('keeps completed status after the final turnEnd event', () => {
    let state = initialState();
    state = reduce(state, { type: 'turnStart', round: 1, role: 'AUTHOR', at: 1000 });
    state = reduce(state, { type: 'turnCompleted', round: 1, role: 'AUTHOR', at: 2000, stopReason: 'end_turn' });
    state = reduce(state, { type: 'turnEnd', round: 1, role: 'AUTHOR', at: 2100 });

    expect(state.rounds.get(1)?.AUTHOR).toMatchObject({
      status: PaneStatus.Completed,
      durationMs: 1100,
    });
  });

  it('does not treat status-less snapshots as running before a turn starts', () => {
    const state = reduce(initialState(), {
      type: 'turnSnapshot',
      round: 1,
      role: 'REVIEWER',
      snapshot: { text: '' },
    });

    expect(state.rounds.get(1)?.REVIEWER.status).toBe(PaneStatus.Pending);
  });

  it('keeps later round reviewer unstarted while author is running', () => {
    let state = initialState();
    state = reduce(state, { type: 'turnStart', round: 2, role: 'AUTHOR', at: 1000 });

    const round = state.rounds.get(2);
    expect(round?.AUTHOR.startedAt).toBe(1000);
    expect(round?.AUTHOR.status).toBe(PaneStatus.Running);
    expect(round?.REVIEWER.startedAt).toBeNull();
    expect(round?.REVIEWER.status).toBe(PaneStatus.Pending);
    expect(state.statuses).toMatchObject({ AUTHOR: PaneStatus.Running, REVIEWER: PaneStatus.Pending });
    expect(state.statuses.AUTHOR).toBe(PaneStatus.Running);
  });

  it('keeps merged tool details when a later snapshot arrives', () => {
    let state = initialState();
    state = reduce(state, { type: 'toolStart', flowId: 1, round: 1, role: 'REVIEWER', toolCallId: 'tool-1', status: PaneStatus.Running, title: 'Run command' });
    state = reduce(state, { type: 'toolUpdate', flowId: 2, round: 1, role: 'REVIEWER', toolCallId: 'tool-1', status: 'running', output: 'partial output', chars: 14 });
    state = reduce(state, { type: 'turnSnapshot', round: 1, role: 'REVIEWER', snapshot: { status: 'running', text: '', tools: [{ id: 'tool-1', tag: '#1', title: 'Run command', status: 'running', inputChars: 3, outputChars: 4 }] } });

    expect(state.rounds.get(1)?.REVIEWER.tools[0]).toMatchObject({ id: 'tool-1', output: 'partial output', chars: 14 });
    expect(state.rounds.get(1)?.REVIEWER.flow.filter((item) => item.kind === 'tool')).toHaveLength(1);
  });

  it('preserves nonzero context usage when a later same-size snapshot reports zero used', () => {
    let state = initialState();
    state = reduce(state, {
      type: 'turnSnapshot',
      round: 1,
      role: 'AUTHOR',
      snapshot: { status: 'running', usage: { used: 1234, size: 200_000 } },
    });
    state = reduce(state, {
      type: 'turnSnapshot',
      round: 1,
      role: 'AUTHOR',
      snapshot: { status: 'running', usage: { used: 0, size: 200_000 } },
    });

    expect(state.rounds.get(1)?.AUTHOR.usage).toMatchObject({ used: 1234, size: 200_000 });
  });

  it('accepts zero context usage when the context size changes', () => {
    let state = initialState();
    state = reduce(state, {
      type: 'turnSnapshot',
      round: 1,
      role: 'AUTHOR',
      snapshot: { status: 'running', usage: { used: 1234, size: 200_000 } },
    });
    state = reduce(state, {
      type: 'turnSnapshot',
      round: 1,
      role: 'AUTHOR',
      snapshot: { status: 'running', usage: { used: 0, size: 100_000 } },
    });

    expect(state.rounds.get(1)?.AUTHOR.usage).toMatchObject({ used: 0, size: 100_000 });
  });

  it('accepts same-size context resets when token telemetry shows a real post-summarization update', () => {
    let state = initialState();
    state = reduce(state, {
      type: 'turnSnapshot',
      round: 1,
      role: 'AUTHOR',
      snapshot: { status: 'running', usage: { used: 1234, size: 200_000, totalTokens: 100 } },
    });
    state = reduce(state, {
      type: 'turnSnapshot',
      round: 1,
      role: 'AUTHOR',
      snapshot: { status: 'running', usage: { used: 0, size: 200_000, totalTokens: 140 } },
    });

    expect(state.rounds.get(1)?.AUTHOR.usage).toMatchObject({ used: 0, size: 200_000, totalTokens: 140 });
  });

  it('does not double count live usage updates already included in the final turn snapshot', () => {
    let state = initialState();
    state = reduce(state, { type: 'turnStart', round: 1, role: 'AUTHOR' });
    state = reduce(state, {
      type: 'usageUpdate',
      role: 'AUTHOR',
      usage: { inputTokens: 100, outputTokens: 25, totalTokens: 125 },
    });
    state = reduce(state, {
      type: 'turnSnapshot',
      round: 1,
      role: 'AUTHOR',
      snapshot: {
        status: 'completed',
        usage: { inputTokens: 100, outputTokens: 25, totalTokens: 125 },
      },
    });

    expect(state.usage.AUTHOR).toMatchObject({ inputTokens: 100, outputTokens: 25, totalTokens: 125 });
    expect(state.rounds.get(1)?.AUTHOR.usage).toMatchObject({ inputTokens: 100, outputTokens: 25, totalTokens: 125 });
  });

  it('merges partial live usage updates for the active turn', () => {
    let state = initialState();
    state = reduce(state, { type: 'turnStart', round: 1, role: 'REVIEWER' });
    state = reduce(state, {
      type: 'usageUpdate',
      role: 'REVIEWER',
      usage: { inputTokens: 20 },
    });
    state = reduce(state, {
      type: 'usageUpdate',
      role: 'REVIEWER',
      usage: { outputTokens: 5, totalTokens: 25 },
    });

    expect(state.usage.REVIEWER).toMatchObject({ inputTokens: 20, outputTokens: 5, totalTokens: 25 });
    expect(state.rounds.get(1)?.REVIEWER.turnUsage).toMatchObject({ inputTokens: 20, outputTokens: 5, totalTokens: 25 });
  });

  it('does not attach delayed usage updates to a later pending round for the same role', () => {
    let state = initialState();
    state = reduce(state, { type: 'turnStart', round: 1, role: 'REVIEWER', at: 100 });
    state = reduce(state, { type: 'turnCompleted', round: 1, role: 'REVIEWER', at: 200, stopReason: 'end_turn' });
    state = reduce(state, { type: 'turnStart', round: 2, role: 'AUTHOR', at: 300 });
    state = reduce(state, {
      type: 'usageUpdate',
      role: 'REVIEWER',
      usage: { inputTokens: 50, totalTokens: 50 },
    });

    expect(state.usage.REVIEWER).toMatchObject({ inputTokens: 50, totalTokens: 50 });
    expect(state.rounds.get(2)?.REVIEWER).toMatchObject({
      status: PaneStatus.Pending,
      startedAt: null,
      usage: null,
      turnUsage: null,
    });
  });

  it('bounds retained trace entries by approximate serialized size', () => {
    let state = initialState();
    for (let index = 0; index < 30; index += 1) {
      state = reduce(state, {
        type: 'traceEntry',
        traceId: index + 1,
        role: 'AUTHOR',
        entry: {
          kind: 'wire',
          at: index,
          direction: 'sent',
          frame: { payload: 'x'.repeat(100_000) },
        },
      });
    }

    expect(state.trace.length).toBeGreaterThan(0);
    expect(JSON.stringify(state.trace).length).toBeLessThan(1_000_000);
    expect(state.trace.at(-1)?.entry.frame).toContain('omitted');
  });

  it('stores per-role plan and replaces it wholesale on each plan update', () => {
    let state = initialState();
    expect(state.plans).toEqual({ AUTHOR: null, REVIEWER: null });

    state = reduce(state, {
      type: 'planUpdate',
      role: 'AUTHOR',
      entries: [
        { content: 'Step A', priority: 'high', status: 'in_progress' },
        { content: 'Step B', priority: 'medium', status: 'pending' },
      ],
    });
    expect(state.plans.AUTHOR?.entries).toHaveLength(2);
    expect(state.plans.AUTHOR?.entries[0].status).toBe('in_progress');

    // ACP spec: each plan update is the complete current plan and must
    // replace the previous one wholesale.
    state = reduce(state, {
      type: 'planUpdate',
      role: 'AUTHOR',
      entries: [
        { content: 'Step A', priority: 'high', status: 'completed' },
        { content: 'Step B', priority: 'medium', status: 'in_progress' },
        { content: 'Step C', priority: 'low', status: 'pending' },
      ],
    });
    expect(state.plans.AUTHOR?.entries).toHaveLength(3);
    expect(state.plans.AUTHOR?.entries[0].status).toBe('completed');
    expect(state.plans.AUTHOR?.entries[2].content).toBe('Step C');
    // REVIEWER plan unaffected.
    expect(state.plans.REVIEWER).toBeNull();
  });

  it('falls back to an empty entries array when planUpdate has no entries', () => {
    const state = reduce(initialState(), { type: 'planUpdate', role: 'REVIEWER' } as any);
    expect(state.plans.REVIEWER?.entries).toEqual([]);
  });

  it('accumulates reasoning blocks separately per reasoningId and tracks total chars', () => {
    let state = initialState();
    state = reduce(state, {
      type: 'reasoningDelta', flowId: 1, reasoningId: 'r1', round: 1, role: 'AUTHOR', delta: 'Plan first. ',
    });
    state = reduce(state, {
      type: 'reasoningDelta', flowId: 2, reasoningId: 'r1', round: 1, role: 'AUTHOR', delta: 'Then patch.',
    });
    state = reduce(state, {
      type: 'reasoningDelta', flowId: 3, reasoningId: 'r2', round: 1, role: 'AUTHOR', delta: 'Check.',
    });

    const reasoning = state.rounds.get(1)?.AUTHOR.reasoning;
    expect(reasoning?.blocks).toHaveLength(2);
    expect(reasoning?.blocks[0]).toMatchObject({ id: 'r1', content: 'Plan first. Then patch.', completed: false });
    expect(reasoning?.blocks[1]).toMatchObject({ id: 'r2', content: 'Check.' });
    expect(reasoning?.totalChars).toBe('Plan first. Then patch.'.length + 'Check.'.length);
  });

  it('marks a reasoning block completed and replaces its content with the canonical text', () => {
    let state = initialState();
    state = reduce(state, {
      type: 'reasoningDelta', flowId: 1, reasoningId: 'r1', round: 1, role: 'AUTHOR', delta: 'partial',
    });
    state = reduce(state, {
      type: 'reasoningCompleted', round: 1, role: 'AUTHOR', reasoningId: 'r1', content: 'final reasoning text',
    });

    const reasoning = state.rounds.get(1)?.AUTHOR.reasoning;
    expect(reasoning?.blocks).toHaveLength(1);
    expect(reasoning?.blocks[0]).toMatchObject({
      id: 'r1',
      content: 'final reasoning text',
      completed: true,
    });
    // totalChars must reflect the canonical content length, not the
    // sum of partial deltas + completion content.
    expect(reasoning?.totalChars).toBe('final reasoning text'.length);
  });

  it('also replaces inline reasoning flow content with canonical completion text', () => {
    let state = initialState();
    state = reduce(state, {
      type: 'reasoningDelta', flowId: 1, reasoningId: 'r1', round: 1, role: 'AUTHOR', delta: 'partial',
    });
    state = reduce(state, {
      type: 'reasoningCompleted', round: 1, role: 'AUTHOR', reasoningId: 'r1', content: 'final reasoning text',
    });

    expect(state.rounds.get(1)?.AUTHOR.flow).toEqual([
      { id: 'flow-r1', sourceId: 'r1', kind: 'reasoning', text: 'final reasoning text' },
    ]);
  });
});
