import { describe, expect, it, vi } from 'vitest';
import { collectTurnResult, type CollectedTurnResult } from '../src/turn-result.js';
import type { RuntimeEventHandlers } from '../src/runtime-event.js';
import type { RuntimeSessionEvent } from '../src/session.js';

function createSession(
  events: RuntimeSessionEvent[],
  reject?: unknown,
  usage: { inputTokens: number; outputTokens: number; totalTokens: number } | null = { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
) {
  let handlers: RuntimeEventHandlers<RuntimeSessionEvent> | null = null;
  const unsubscribe = vi.fn(() => { handlers = null; });
  return {
    unsubscribe,
    session: {
      on(nextHandlers: RuntimeEventHandlers<RuntimeSessionEvent>) {
        handlers = nextHandlers;
        return unsubscribe;
      },
      async prompt() {
        for (const event of events) {
          const key = event.type.replace(/\.([a-z])/g, (_, char: string) => char.toUpperCase());
          const handler = handlers?.[key as keyof RuntimeEventHandlers<RuntimeSessionEvent>] as ((event: RuntimeSessionEvent) => void) | undefined;
          handler?.(event);
        }
        if (reject) throw reject;
        return { stopReason: 'end_turn', usage };
      },
    },
  };
}

describe('collectTurnResult', () => {
  it('streams updates and returns collected text and tools', async () => {
    const { session, unsubscribe } = createSession([
      { type: 'message.delta', sessionId: 's1', at: 1, messageId: 'm1', delta: 'APP' },
      { type: 'tool.start', sessionId: 's1', at: 2, toolCallId: 't1', name: 'read', title: 'Read file', status: 'running', input: { text: 'abc' } },
      { type: 'tool.end', sessionId: 's1', at: 3, toolCallId: 't1', status: 'completed', output: { text: 'abcdef' } },
      { type: 'message.delta', sessionId: 's1', at: 4, messageId: 'm1', delta: 'ROVED' },
      { type: 'turn.completed', sessionId: 's1', at: 5, turnId: 'turn1', stopReason: 'end_turn' },
    ]);
    const updates: CollectedTurnResult[] = [];

    const result = await collectTurnResult(session as never, 'review', {
      onUpdate: (snapshot) => updates.push(snapshot),
    });

    expect(result.text).toBe('APPROVED');
    expect(result.status).toBe('completed');
    expect(result.stopReason).toBe('end_turn');
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 2, totalTokens: 12 });
    expect(result.tools).toEqual([
      { id: 't1', tag: '#1', name: 'read', title: 'Read file', status: 'completed', inputChars: 3, outputChars: 6 },
    ]);
    expect(updates.map((update) => update.text)).toContain('APPROVED');
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('uses completed message content when it corrects partial streamed deltas', async () => {
    const { session } = createSession([
      { type: 'message.delta', sessionId: 's1', at: 1, messageId: 'm1', delta: 'APP' },
      { type: 'message.delta', sessionId: 's1', at: 2, messageId: 'm1', delta: 'RO' },
      { type: 'message.completed', sessionId: 's1', at: 3, messageId: 'm1', content: 'APPROVED\nFinal answer with corrected content.' } as RuntimeSessionEvent,
      { type: 'turn.completed', sessionId: 's1', at: 4, turnId: 'turn1', stopReason: 'end_turn' },
    ]);
    const updates: string[] = [];

    const result = await collectTurnResult(session as never, 'review', {
      onUpdate: (snapshot) => updates.push(snapshot.text),
    });

    expect(result.text).toBe('APPROVED\nFinal answer with corrected content.');
    expect(result.text).not.toBe('APPRO');
    expect(updates).toContain('APPROVED\nFinal answer with corrected content.');
  });

  it('forwards reasoning events to callbacks without mixing them into message text', async () => {
    const { session } = createSession([
      { type: 'reasoning.delta', sessionId: 's1', at: 1, reasoningId: 'r1', delta: 'Think first.' },
      { type: 'reasoning.completed', sessionId: 's1', at: 2, reasoningId: 'r1', content: 'Think first.' },
      { type: 'message.delta', sessionId: 's1', at: 3, messageId: 'm1', delta: 'Final' },
      { type: 'turn.completed', sessionId: 's1', at: 4, turnId: 'turn1', stopReason: 'end_turn' },
    ]);
    const eventTypes: string[] = [];

    const result = await collectTurnResult(session as never, 'review', {
      includeEvents: true,
      onEvent: (event) => eventTypes.push(event.type),
    });

    expect(result.text).toBe('Final');
    expect(eventTypes).toEqual([
      'reasoning.delta',
      'reasoning.completed',
      'message.delta',
      'turn.completed',
    ]);
    expect(result.events?.map((event) => event.type)).toContain('reasoning.delta');
  });

  it('collects partial token usage updates', async () => {
    const { session } = createSession([
      { type: 'session.usage.updated', sessionId: 's1', at: 1, inputTokens: 20 } as RuntimeSessionEvent,
      { type: 'session.usage.updated', sessionId: 's1', at: 2, outputTokens: 5, totalTokens: 25 } as RuntimeSessionEvent,
      { type: 'turn.completed', sessionId: 's1', at: 3, turnId: 'turn1', stopReason: 'end_turn' },
    ], undefined, null);

    const result = await collectTurnResult(session as never, 'review');

    expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 5, totalTokens: 25 });
  });

  it('collects ACP context usage updates with used and size', async () => {
    const { session } = createSession([
      { type: 'session.usage.updated', sessionId: 's1', at: 1, used: 12_345, size: 200_000 } as RuntimeSessionEvent,
      { type: 'turn.completed', sessionId: 's1', at: 2, turnId: 'turn1', stopReason: 'end_turn' },
    ], undefined, null);

    const result = await collectTurnResult(session as never, 'review');

    expect(result.usage).toEqual({ used: 12_345, size: 200_000 });
  });

  it('preserves nonzero context usage when a later same-size update reports zero used', async () => {
    const { session } = createSession([
      { type: 'session.usage.updated', sessionId: 's1', at: 1, used: 12_345, size: 200_000 } as RuntimeSessionEvent,
      { type: 'session.usage.updated', sessionId: 's1', at: 2, used: 0, size: 200_000 } as RuntimeSessionEvent,
      { type: 'turn.completed', sessionId: 's1', at: 3, turnId: 'turn1', stopReason: 'end_turn' },
    ], undefined, null);

    const result = await collectTurnResult(session as never, 'review');

    expect(result.usage).toEqual({ used: 12_345, size: 200_000 });
  });

  it('accepts zero context usage when the context size changes', async () => {
    const { session } = createSession([
      { type: 'session.usage.updated', sessionId: 's1', at: 1, used: 12_345, size: 200_000 } as RuntimeSessionEvent,
      { type: 'session.usage.updated', sessionId: 's1', at: 2, used: 0, size: 100_000 } as RuntimeSessionEvent,
      { type: 'turn.completed', sessionId: 's1', at: 3, turnId: 'turn1', stopReason: 'end_turn' },
    ], undefined, null);

    const result = await collectTurnResult(session as never, 'review');

    expect(result.usage).toEqual({ used: 0, size: 100_000 });
  });

  it('preserves context usage when prompt response also reports token usage', async () => {
    const { session } = createSession([
      { type: 'session.usage.updated', sessionId: 's1', at: 1, used: 12_345, size: 200_000 } as RuntimeSessionEvent,
      { type: 'turn.completed', sessionId: 's1', at: 2, turnId: 'turn1', stopReason: 'end_turn' },
    ], undefined, { inputTokens: 10, outputTokens: 2, totalTokens: 12 });

    const result = await collectTurnResult(session as never, 'review');

    expect(result.usage).toEqual({
      used: 12_345,
      size: 200_000,
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
    });
  });

  it('completes from prompt result when an adapter omits turn.completed', async () => {
    const { session, unsubscribe } = createSession([
      { type: 'message.delta', sessionId: 's1', at: 1, messageId: 'm1', delta: 'final answer' },
    ]);

    const result = await collectTurnResult(session as never, 'review');

    expect(result).toMatchObject({
      text: 'final answer',
      status: 'completed',
      stopReason: 'end_turn',
    });
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('keeps the subscription active until RuntimeSession emits late turn.completed', async () => {
    vi.useFakeTimers();
    let handlers: RuntimeEventHandlers<RuntimeSessionEvent> | null = null;
    const unsubscribe = vi.fn(() => { handlers = null; });
    const session = {
      on(nextHandlers: RuntimeEventHandlers<RuntimeSessionEvent>) {
        handlers = nextHandlers;
        return unsubscribe;
      },
      async prompt() {
        handlers?.toolStart?.({
          type: 'tool.start',
          sessionId: 's1',
          at: 1,
          turnId: 'turn1',
          toolCallId: 'tool-1',
          name: 'Edit',
          status: 'running',
        });
        setTimeout(() => {
          handlers?.toolEnd?.({
            type: 'tool.end',
            sessionId: 's1',
            at: 2,
            turnId: 'turn1',
            toolCallId: 'tool-1',
            status: 'completed',
            output: { text: 'ok' },
          });
          handlers?.messageDelta?.({ type: 'message.delta', sessionId: 's1', at: 3, turnId: 'turn1', messageId: 'm1', delta: 'final' });
          handlers?.turnCompleted?.({ type: 'turn.completed', sessionId: 's1', at: 4, turnId: 'turn1', stopReason: 'end_turn' });
        }, 20);
        await vi.advanceTimersByTimeAsync(20);
        return { stopReason: 'end_turn', usage: null };
      },
    };

    try {
      const result = await collectTurnResult(session as never, 'review');

      expect(result.text).toBe('final');
      expect(result.tools).toEqual([
        { id: 'tool-1', tag: '#1', name: 'Edit', status: 'completed', inputChars: 0, outputChars: 2 },
      ]);
      expect(result.status).toBe('completed');
      expect(unsubscribe).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('unsubscribes when the prompt fails', async () => {
    const error = new Error('boom');
    const { session, unsubscribe } = createSession([
      { type: 'message.delta', sessionId: 's1', at: 1, messageId: 'm1', delta: 'partial' },
      { type: 'turn.failed', sessionId: 's1', at: 2, turnId: 'turn1', error: 'boom' },
    ], error);

    await expect(collectTurnResult(session as never, 'review')).rejects.toThrow('boom');
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
