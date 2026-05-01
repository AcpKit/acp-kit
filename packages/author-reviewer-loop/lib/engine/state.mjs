export const PaneStatus = Object.freeze({
  Pending: 'waiting',
  Running: 'running',
  Completed: 'completed',
  Failed: 'failed',
});

export const Phase = Object.freeze({
  Idle: 'idle',
  Launching: 'launching',
  Running: 'running',
  Done: 'done',
  Error: 'error',
});

const TRACE_ENTRY_LIMIT = 1000;
const TRACE_TOTAL_BYTES = 1_000_000;
const TRACE_ENTRY_BYTES = 64_000;

function emptyUsage() {
  return {
    used: 0,
    size: 0,
    cost: null,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedReadTokens: 0,
    cachedWriteTokens: 0,
    thoughtTokens: 0,
  };
}

function emptyPane() {
  return {
    status: PaneStatus.Pending,
    lines: [],
    current: '',
    flow: [],
    tools: [],
    // Reasoning is accumulated per `reasoningId` so renderers can show a
    // dedicated "thinking" view (independent of the inline `flow` rendering)
    // and so consumers can summarize total reasoning at turn end. Each block
    // is `{ id, content, completed, charCount }`. Reasoning is also kept
    // in `flow` (with kind: 'reasoning') for inline rendering continuity.
    reasoning: { blocks: [], totalChars: 0 },
    usage: null,
    turnUsage: null,
    stopReason: null,
    error: null,
    chars: 0,
    startedAt: null,
    finishedAt: null,
    durationMs: null,
  };
}

function emptyRound() {
  return { AUTHOR: emptyPane(), REVIEWER: emptyPane() };
}

export function initialState() {
  return {
    phase: Phase.Idle,
    statuses: { AUTHOR: 'launching', REVIEWER: 'launching' },
    rounds: new Map(),
    order: [],
    trace: [],
    latest: null,
    usage: { AUTHOR: emptyUsage(), REVIEWER: emptyUsage() },
    // Latest agent execution plan per role, normalized from ACP `plan`
    // session updates. Each plan replaces the role's slot wholesale per
    // the ACP spec ("the agent must send a complete list of all entries").
    plans: { AUTHOR: null, REVIEWER: null },
    result: null,
    approvalPending: false,
    error: null,
    startedAt: null,
    finishedAt: null,
  };
}

function addUsage(left, right) {
  const next = { ...emptyUsage(), ...(left || {}) };
  if (!right) return next;
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'cachedReadTokens', 'cachedWriteTokens', 'thoughtTokens']) {
    const value = right[key];
    if (Number.isFinite(value)) next[key] += value;
  }
  mergeContextUsage(next, right);
  const cost = right.cost;
  if (Number.isFinite(cost) || cost === null) next.cost = cost;
  return next;
}

function mergeContextUsage(target, source) {
  const nextSize = Number.isFinite(source.size) ? source.size : undefined;
  const nextUsed = Number.isFinite(source.used) ? source.used : undefined;
  const previousSize = Number.isFinite(target.size) ? target.size : undefined;
  const previousUsed = Number.isFinite(target.used) ? target.used : undefined;

  if (nextSize !== undefined) target.size = nextSize;
  if (nextUsed === undefined) return;
  if (
    nextUsed === 0
    && nextSize !== undefined
    && previousSize === nextSize
    && previousUsed > 0
    && !hasSupportingUsageTelemetry(source)
  ) return;
  target.used = nextUsed;
}

function hasSupportingUsageTelemetry(source) {
  if (!source || typeof source !== 'object') return false;
  return ['inputTokens', 'outputTokens', 'totalTokens', 'cachedReadTokens', 'cachedWriteTokens', 'thoughtTokens']
    .some((key) => Number.isFinite(source[key]));
}

function subtractUsage(left, right) {
  const next = { ...emptyUsage(), ...(left || {}) };
  if (!right) return next;
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'cachedReadTokens', 'cachedWriteTokens', 'thoughtTokens']) {
    const value = right[key];
    if (Number.isFinite(value)) next[key] = Math.max(0, next[key] - value);
  }
  return next;
}

function mergeUsage(previous, nextUsage) {
  const next = { ...(previous || {}) };
  if (!nextUsage) return next;
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'cachedReadTokens', 'cachedWriteTokens', 'thoughtTokens']) {
    const value = nextUsage[key];
    if (Number.isFinite(value)) next[key] = value;
  }
  mergeContextUsage(next, nextUsage);
  const cost = nextUsage.cost;
  if (Number.isFinite(cost) || cost === null) next.cost = cost;
  return next;
}

function ensureRound(state, round) {
  if (state.rounds.has(round)) return state;
  const rounds = new Map(state.rounds);
  rounds.set(round, emptyRound());
  const order = [...state.order];
  if (!order.includes(round)) {
    order.push(round);
    order.sort((a, b) => a - b);
  }
  return { ...state, rounds, order, latest: order[order.length - 1] };
}

function patchPane(state, round, role, mutate) {
  const rounds = new Map(state.rounds);
  const entry = rounds.get(round) || emptyRound();
  rounds.set(round, { ...entry, [role]: mutate({ ...entry[role] }) });
  return { ...state, rounds };
}

function paneFromTurnSnapshot(snapshot, previous = emptyPane(), cumulativeUsage = previous.usage) {
  const text = typeof snapshot.text === 'string' ? snapshot.text : '';
  const tools = Array.isArray(snapshot.tools) ? snapshot.tools : [];
  const parts = text.split('\n');
  const current = parts.pop() ?? '';
  const status = normalizeSnapshotStatus(snapshot.status, previous.status);
  const previousToolsById = new Map(previous.tools.map((tool) => [tool.id, tool]));
  const snapshotTools = tools.map((tool) => {
    const previousTool = previousToolsById.get(tool.id);
    return {
      id: tool.id,
      tag: tool.tag ?? previousTool?.tag,
      name: tool.name ?? previousTool?.name,
      title: tool.title || tool.name || previousTool?.title || tool.id,
      status: tool.status ?? previousTool?.status,
      chars: Math.max(maxFinite(tool.inputChars, tool.outputChars), previousTool?.chars ?? 0),
      input: tool.input ?? previousTool?.input,
      output: tool.output ?? previousTool?.output,
    };
  });
  const snapshotIds = new Set(snapshotTools.map((tool) => tool.id));
  const preservedLiveTools = previous.tools.filter((tool) => !snapshotIds.has(tool.id));
  return {
    status,
    lines: parts,
    current,
    flow: previous.flow,
    tools: [...snapshotTools, ...preservedLiveTools],
    reasoning: previous.reasoning ?? { blocks: [], totalChars: 0 },
    usage: cumulativeUsage ?? previous.usage,
    turnUsage: snapshot.usage ?? previous.turnUsage,
    stopReason: snapshot.stopReason,
    error: snapshot.error,
    chars: text.length,
    startedAt: previous.startedAt,
    finishedAt: previous.finishedAt,
    durationMs: previous.durationMs,
  };
}

function normalizeSnapshotStatus(status, fallback) {
  if (status === 'completed') return PaneStatus.Completed;
  if (status === 'failed' || status === 'cancelled') return PaneStatus.Failed;
  if (status === 'running') return PaneStatus.Running;
  return fallback;
}

function maxFinite(...values) {
  return values.reduce((max, value) => Number.isFinite(value) ? Math.max(max, value) : max, 0);
}

function appendTextFlow(pane, delta, flowId, kind = 'text') {
  if (!delta) return pane;
  const flow = [...pane.flow];
  const sourceId = kind === 'reasoning' ? (flowId ?? 'default-reasoning') : flowId;
  const targetIndex = flow.length - 1;
  const target = flow[targetIndex];
  if (target?.kind === kind && (kind !== 'reasoning' || target.sourceId === sourceId)) {
    flow[targetIndex] = { ...target, text: appendStreamText(target.text, delta) };
  } else {
    const baseId = `flow-${sourceId ?? flow.length + 1}`;
    const id = flow.some((item) => item.id === baseId) ? `${baseId}-${flow.length + 1}` : baseId;
    flow.push({ id, sourceId, kind, text: delta });
  }
  return { ...pane, flow };
}

function appendStreamText(previous, next) {
  if (!next) return previous || '';
  if (!previous) return next;
  if (next === previous || next.startsWith(previous)) return next;
  const overlap = suffixPrefixOverlap(previous, next);
  if (overlap > 1) return previous + next.slice(overlap);
  if (/\s$/.test(previous) || /^\s/.test(next)) return previous + next;
  if (/[0-9]$/.test(previous) && /^[0-9]/.test(next)) {
    return previous + next;
  }
  if (/[A-Za-z]$/.test(previous) && /^[A-Za-z]/.test(next)) {
    return looksLikeSplitWord(previous, next) ? previous + next : `${previous} ${next}`;
  }
  if (/[A-Za-z0-9)]$/.test(previous) && /^[(`]/.test(next)) {
    return previous + next;
  }
  return previous + next;
}

function looksLikeSplitWord(previous, next) {
  const previousTail = previous.match(/([A-Za-z]+)$/)?.[1] ?? '';
  const nextHead = next.match(/^([A-Za-z]+)/)?.[1] ?? '';
  if (!previousTail || !nextHead) return false;
  const previousTailLower = previousTail.toLowerCase();
  const joinedLower = `${previousTail}${nextHead}`.toLowerCase();
  if (/^(?:world|complete|websocket|websockets|webhook|webhooks|webview|webviews|webpack|website|websites|localhost|middleware|typescript|javascript|stylesheet|database|databases|filesystem|hostname|username|pathname|metadata|workspace|workspaces|endpoint|endpoints|callback|callbacks|backend|frontend|runtime|subprocess|codebase|codebases|tokens?|tooling)$/.test(joinedLower)) {
    return true;
  }
  if (/^(?:un|re|dis|pre|sub|mis|de|over|under|out|co|non|semi|bi|tri|anti|auto|counter|hyper|infra|inter|macro|micro|multi|pseudo|super|tele|thermo|trans|ultra)$/i.test(previousTailLower)) {
    return true;
  }
  return /^(?:socket|sockets|hook|hooks|view|views|pack|site|sites|host|name|path|point|points|base|bases|time|ware|script|style|sheet|system|space|spaces|tion|sion|ation|ition|ption|ction|ctions|tions|sions|mation|cation|fication|gation|lation|ration|mentation|umentation|ment|ments|ness|less|able|ible|ally|fully|ously|ingly|edly|ities|ality|istic|ology|graphy|scope|ship|hood|ward|wards|ized|ising|izing|ed|er|ers|est|ly|al|ial|ual|ive|ives|ize|ise|ous|ant|ent)$/i.test(nextHead);
}
function suffixPrefixOverlap(left, right) {
  const max = Math.min(left.length, right.length);
  for (let length = max; length > 0; length -= 1) {
    if (left.endsWith(right.slice(0, length))) return length;
  }
  return 0;
}

function replaceReasoningFlowContent(pane, reasoningId, content) {
  if (!reasoningId || typeof content !== 'string') return pane;
  const indices = pane.flow
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.kind === 'reasoning' && item.sourceId === reasoningId)
    .map(({ index }) => index);
  if (indices.length !== 1) return pane;
  const flow = [...pane.flow];
  const index = indices[0];
  flow[index] = { ...flow[index], text: content };
  return { ...pane, flow };
}

/**
 * Append a reasoning delta to the dedicated `pane.reasoning` accumulator
 * (separate from `pane.flow`, which keeps reasoning inline for transcript-
 * style rendering). Each block is keyed by `reasoningId`; consecutive deltas
 * on the same id append to the existing block, otherwise we start a new one.
 */
function appendReasoningBlock(pane, reasoningId, delta, completed) {
  if (!delta) return pane;
  const id = reasoningId ?? `reasoning-${pane.reasoning.blocks.length + 1}`;
  const blocks = [...pane.reasoning.blocks];
  const index = blocks.findIndex((block) => block.id === id);
  if (index >= 0) {
    const content = appendStreamText(blocks[index].content, delta);
    blocks[index] = {
      ...blocks[index],
      content,
      charCount: content.length,
      completed: completed || blocks[index].completed,
    };
  } else {
    blocks.push({ id, content: delta, charCount: delta.length, completed: Boolean(completed) });
  }
  return {
    ...pane,
    reasoning: { blocks, totalChars: blocks.reduce((total, block) => total + block.charCount, 0) },
  };
}

/**
 * Mark a reasoning block complete, optionally replacing its accumulated
 * content with the canonical full content from the `reasoning.completed`
 * event. We compute the delta (charCount diff) so the running totalChars
 * stays consistent.
 */
function completeReasoningBlock(pane, reasoningId, fullContent) {
  if (!reasoningId) return pane;
  const blocks = [...pane.reasoning.blocks];
  const index = blocks.findIndex((block) => block.id === reasoningId);
  const finalContent = typeof fullContent === 'string' ? fullContent : (blocks[index]?.content ?? '');
  if (index >= 0) {
    const previous = blocks[index];
    blocks[index] = {
      ...previous,
      content: finalContent,
      charCount: finalContent.length,
      completed: true,
    };
    const totalChars = pane.reasoning.totalChars - previous.charCount + finalContent.length;
    return { ...pane, reasoning: { blocks, totalChars: Math.max(0, totalChars) } };
  }
  blocks.push({ id: reasoningId, content: finalContent, charCount: finalContent.length, completed: true });
  return {
    ...pane,
    reasoning: { blocks, totalChars: pane.reasoning.totalChars + finalContent.length },
  };
}

function appendOrUpdateToolFlow(pane, event, flowId) {
  const toolCallId = normalizeToolCallId(event, pane, flowId);
  const flow = [...pane.flow];
  const index = flow.findIndex((item) => item.kind === 'tool' && item.toolCallId === toolCallId);
  const previous = index >= 0 ? flow[index] : null;
  const next = {
    id: previous?.id ?? `flow-${flowId}`,
    kind: 'tool',
    toolCallId,
    tag: event.tag ?? previous?.tag,
    name: event.name ?? previous?.name,
    title: event.title ?? previous?.title,
    status: event.status ?? previous?.status ?? PaneStatus.Running,
    chars: event.chars ?? previous?.chars ?? 0,
    input: event.input ?? previous?.input,
    output: event.output ?? previous?.output,
  };
  if (index >= 0) flow[index] = { ...previous, ...next };
  else flow.push(next);

  const tools = [...pane.tools];
  const toolIndex = tools.findIndex((item) => item.id === toolCallId);
  const previousTool = toolIndex >= 0 ? tools[toolIndex] : {};
  const tool = {
    ...previousTool,
    id: toolCallId,
    tag: next.tag,
    name: next.name,
    title: next.title,
    status: next.status,
    chars: next.chars,
    input: next.input,
    output: next.output,
  };
  if (toolIndex >= 0) tools[toolIndex] = tool;
  else tools.push(tool);

  return { ...pane, flow, tools };
}

function normalizeToolCallId(event, pane, flowId) {
  if (event.toolCallId) return event.toolCallId;
  if (event.type === 'toolStart') return nextSyntheticToolCallId(pane, flowId ?? pane.tools.length + 1);

  const eventTitle = event.title;
  const hasIdentity = Boolean(event.name || eventTitle);
  const runningSyntheticTools = pane.tools.filter((tool) =>
    tool?.id && String(tool.id).startsWith('tool-event-') && tool.status === PaneStatus.Running,
  );
  const reusable = [...runningSyntheticTools].reverse().find((tool) => {
    if (!hasIdentity) return runningSyntheticTools.length === 1 && runningSyntheticTools[0].id === tool.id;
    if (event.name && (!tool.name || event.name !== tool.name)) return false;
    if (eventTitle && (!tool.title || (eventTitle !== tool.title && !sameNormalizedToolTitle(eventTitle, tool.title)))) return false;
    return true;
  });
  if (reusable) return reusable.id;
  return nextSyntheticToolCallId(pane, flowId ?? pane.tools.length + 1);
}

function nextSyntheticToolCallId(pane, preferredIndex) {
  const existing = new Set((pane.tools || []).map((tool) => tool?.id).filter(Boolean));
  let candidate = Number.isInteger(preferredIndex) && preferredIndex > 0 ? preferredIndex : 1;
  while (existing.has(`tool-event-${candidate}`)) candidate += 1;
  return `tool-event-${candidate}`;
}

function normalizeToolTitle(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/[\u2500-\u257f]/g, '')
    .trim()
    .toLowerCase();
}

function sameNormalizedToolTitle(left, right) {
  const normalizedLeft = normalizeToolTitle(left);
  const normalizedRight = normalizeToolTitle(right);
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}

function pushTrace(state, action) {
  const item = boundTraceItem({ id: `trace-${action.traceId}`, role: action.role, entry: action.entry });
  const trace = [
    ...state.trace,
    item,
  ];
  return { ...state, trace: trimTrace(trace) };
}

function trimTrace(trace) {
  const kept = [];
  let bytes = 0;
  for (let index = trace.length - 1; index >= 0; index -= 1) {
    const item = trace[index];
    const size = approximateJsonBytes(item);
    if (kept.length >= TRACE_ENTRY_LIMIT) break;
    if (kept.length > 0 && bytes + size > TRACE_TOTAL_BYTES) break;
    kept.push(item);
    bytes += size;
  }
  return kept.reverse();
}

function boundTraceItem(item) {
  if (approximateJsonBytes(item) <= TRACE_ENTRY_BYTES) return item;

  const entry = item.entry && typeof item.entry === 'object'
    ? {
      ...item.entry,
      frame: `[omitted: trace frame exceeded ${TRACE_ENTRY_BYTES} bytes]`,
    }
    : '[omitted: trace entry exceeded size limit]';

  const bounded = { ...item, entry };
  if (approximateJsonBytes(bounded) <= TRACE_ENTRY_BYTES) return bounded;
  return {
    id: item.id,
    role: item.role,
    entry: '[omitted: trace entry exceeded size limit]',
  };
}

function approximateJsonBytes(value) {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return TRACE_ENTRY_BYTES + 1;
  }
}

function findLatestActiveRoundForRole(state, role) {
  for (let index = state.order.length - 1; index >= 0; index -= 1) {
    const round = state.order[index];
    const pane = state.rounds.get(round)?.[role];
    if (pane?.startedAt != null && pane.finishedAt == null) return round;
  }
  return null;
}

export function reduce(state, action) {
  switch (action.type) {
    case 'launching':
      return { ...state, phase: Phase.Launching, result: null, startedAt: state.startedAt ?? Date.now() };
    case 'roleStatus':
      return { ...state, statuses: { ...state.statuses, [action.role]: action.message } };
    case 'turnStart': {
      const otherRole = action.role === 'AUTHOR' ? 'REVIEWER' : 'AUTHOR';
      const base = {
        ...state,
        phase: Phase.Running,
        result: null,
        approvalPending: false,
        statuses: { ...state.statuses, [action.role]: PaneStatus.Running, [otherRole]: PaneStatus.Pending },
      };
      const next = ensureRound(base, action.round);
      return patchPane(next, action.round, action.role, (p) => ({
        ...p,
        status: PaneStatus.Running,
        usage: state.usage[action.role],
        turnUsage: null,
        startedAt: action.at ?? Date.now(),
        finishedAt: null,
        durationMs: null,
      }));
    }
    case 'turnSnapshot': {
      let next = ensureRound(state, action.round);
      const pane = next.rounds.get(action.round)?.[action.role] ?? emptyPane();
      let roleUsage = next.usage[action.role];
      if (action.snapshot.usage) {
        roleUsage = addUsage(subtractUsage(roleUsage, pane.turnUsage), action.snapshot.usage);
        next = { ...next, usage: { ...next.usage, [action.role]: roleUsage } };
      }
      return patchPane(next, action.round, action.role, (currentPane) =>
        paneFromTurnSnapshot(action.snapshot, currentPane, roleUsage),
      );
    }
    case 'delta':
      return patchPane(ensureRound(state, action.round), action.round, action.role, (pane) =>
        appendTextFlow(pane, action.delta, action.flowId),
      );
    case 'reasoningDelta':
      return patchPane(ensureRound(state, action.round), action.round, action.role, (pane) => {
        const reasoningId = action.reasoningId ?? action.flowId;
        const withFlow = appendTextFlow(pane, action.delta, reasoningId, 'reasoning');
        return appendReasoningBlock(withFlow, reasoningId, action.delta, false);
      });
    case 'reasoningCompleted':
      return patchPane(ensureRound(state, action.round), action.round, action.role, (pane) => {
        const completed = completeReasoningBlock(pane, action.reasoningId, action.content);
        return replaceReasoningFlowContent(completed, action.reasoningId, action.content);
      });
    case 'planUpdate': {
      const entries = Array.isArray(action.entries) ? action.entries : [];
      return {
        ...state,
        plans: {
          ...state.plans,
          [action.role]: { entries, at: action.at ?? Date.now() },
        },
      };
    }
    case 'turnCompleted':
      return finishPaneTurn(state, action, PaneStatus.Completed, { stopReason: action.stopReason });
    case 'turnFailed':
      return finishPaneTurn(state, action, PaneStatus.Failed, { error: action.error });
    case 'turnEnd':
      return finishPaneTurn(state, action, undefined, {}, { preserveTerminalStatus: true });
    case 'toolStart':
    case 'toolUpdate':
    case 'toolEnd':
      return patchPane(ensureRound(state, action.round), action.round, action.role, (pane) =>
        appendOrUpdateToolFlow(pane, action, action.flowId),
      );
    case 'traceEntry':
      return pushTrace(state, action);
    case 'usageUpdate': {
      const activeRound = findLatestActiveRoundForRole(state, action.role);
      if (activeRound == null) {
        const roleUsage = addUsage(state.usage[action.role], action.usage);
        return { ...state, usage: { ...state.usage, [action.role]: roleUsage } };
      }
      const pane = state.rounds.get(activeRound)?.[action.role] ?? emptyPane();
      const turnUsage = mergeUsage(pane.turnUsage, action.usage);
      const roleUsage = addUsage(subtractUsage(state.usage[action.role], pane.turnUsage), turnUsage);
      const next = { ...state, usage: { ...state.usage, [action.role]: roleUsage } };
      return patchPane(next, activeRound, action.role, (currentPane) => ({
        ...currentPane,
        usage: roleUsage,
        turnUsage,
      }));
    }
    case 'approvalPending':
      return { ...state, phase: Phase.Done, result: action.result, approvalPending: true, finishedAt: Date.now() };
    case 'approvalContinued':
      return {
        ...state,
        phase: Phase.Running,
        result: null,
        approvalPending: false,
        finishedAt: null,
        statuses: { ...state.statuses, AUTHOR: PaneStatus.Pending, REVIEWER: PaneStatus.Pending },
      };
    case 'result':
      return { ...state, phase: Phase.Done, result: action.result, approvalPending: false, finishedAt: Date.now() };
    case 'error':
      return { ...state, phase: Phase.Error, approvalPending: false, error: action.error, finishedAt: Date.now() };
    default:
      return state;
  }
}

function finishPaneTurn(state, action, status, patch = {}, options = {}) {
  return patchPane(ensureRound(state, action.round), action.round, action.role, (pane) => {
    const finishedAt = action.at ?? Date.now();
    const startedAt = pane.startedAt ?? finishedAt;
    const nextStatus = options.preserveTerminalStatus
      && (pane.status === PaneStatus.Completed || pane.status === PaneStatus.Failed)
      ? pane.status
      : status ?? pane.status;
    return {
      ...pane,
      ...patch,
      status: nextStatus,
      startedAt,
      finishedAt,
      durationMs: Math.max(0, finishedAt - startedAt),
    };
  });
}
