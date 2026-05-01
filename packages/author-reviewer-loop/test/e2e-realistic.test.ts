import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runAuthorReviewerLoop } from '../lib/runtime/loop.mjs';
import { createLoopEngine } from '../lib/engine.mjs';

class FakeSession {
  private handlers: Record<string, (event: unknown) => void> = {};

  constructor(private readonly eventsByPrompt: (prompt: string) => unknown[]) {}

  on(handlers: Record<string, (event: unknown) => void>) {
    this.handlers = handlers;
    return () => { this.handlers = {}; };
  }

  async prompt(prompt: string) {
    for (const event of this.eventsByPrompt(prompt)) {
      const key = String((event as { type?: string }).type || '').replace(/\.([a-z])/g, (_match, char: string) => char.toUpperCase());
      this.handlers[key]?.(event);
    }
    return { stopReason: 'end_turn' };
  }
}

describe('author-reviewer-loop realistic E2E', () => {
  it('runs loop, turn adapter, and collector without mocking internals', async () => {
    const authorSession = new FakeSession((prompt) => [
      { type: 'message.delta', sessionId: 'author', at: 1, messageId: 'a1', delta: prompt.includes('missing persistence') ? 'fixed persistence' : 'draft only' },
      { type: 'tool.start', sessionId: 'author', at: 2, toolCallId: 'author-test', name: 'test', title: 'Run focused tests', status: 'running', input: 'npm test' },
      { type: 'tool.end', sessionId: 'author', at: 3, toolCallId: 'author-test', status: 'completed', output: 'passed' },
      { type: 'turn.completed', sessionId: 'author', at: 4, turnId: 'author-turn', stopReason: 'end_turn' },
    ]);
    const reviewerSession = new FakeSession((prompt) => [
      {
        type: 'message.completed',
        sessionId: 'reviewer',
        at: 5,
        messageId: 'r1',
        content: prompt.includes('fixed persistence')
          ? 'APPROVED\nRestart recovery verified by focused tests.'
          : 'NOT APPROVED: missing persistence after restart.',
      },
      { type: 'turn.completed', sessionId: 'reviewer', at: 6, turnId: 'reviewer-turn', stopReason: 'end_turn' },
    ]);
    const rendererEvents: unknown[] = [];

    const result = await runAuthorReviewerLoop({
      config: {
        cwd: process.cwd(),
        maxRounds: 3,
        trace: false,
        tui: false,
        authorSettings: {
          prompt: ({ round, feedback }: { round: number; feedback: string }) => `round=${round}; feedback=${feedback || '<none>'}`,
        },
        reviewerSettings: {
          prompt: ({ authorReply }: { authorReply: string }) => `review author=${authorReply}`,
        },
        openRole: async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) => ({
          role,
          session: role === 'AUTHOR' ? authorSession : reviewerSession,
        }),
        closeRole: async () => undefined,
      },
      renderer: {
        onTurnSnapshot: (event: unknown) => rendererEvents.push(event),
        onToolEnd: (event: unknown) => rendererEvents.push(event),
        onResult: (event: unknown) => rendererEvents.push(event),
      },
    });

    expect(result).toMatchObject({ approved: true, rounds: 2 });
    expect(rendererEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'toolEnd', role: 'AUTHOR', round: 1, output: 'passed' }),
      expect.objectContaining({ approved: true, rounds: 2 }),
    ]));
  });

  it('lets the refreshed reviewer read author-written files from the workspace on the next round', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'spar-review-fresh-'));
    const taskFile = path.join(cwd, 'notes.txt');
    await fs.writeFile(taskFile, 'before', 'utf8');

    class FileAwareSession {
      handlers: Record<string, (event: unknown) => void> = {};

      constructor(readonly role: 'AUTHOR' | 'REVIEWER') {}

      on(handlers: Record<string, (event: unknown) => void>) {
        this.handlers = handlers;
        return () => { this.handlers = {}; };
      }

      async prompt(prompt: string) {
        if (this.role === 'AUTHOR') {
          if (prompt.includes('Reviewer saw stale file content')) {
            await fs.writeFile(taskFile, 'after', 'utf8');
            this.handlers.messageDelta?.({ type: 'message.delta', sessionId: 'author', at: 3, messageId: 'a2', delta: 'updated file to after' });
          } else {
            this.handlers.messageDelta?.({ type: 'message.delta', sessionId: 'author', at: 1, messageId: 'a1', delta: 'initial pass' });
          }
          this.handlers.turnCompleted?.({ type: 'turn.completed', sessionId: 'author', at: 4, turnId: 'author-turn', stopReason: 'end_turn' });
          return { stopReason: 'end_turn' };
        }

        const content = await fs.readFile(taskFile, 'utf8');
        const reply = content === 'after'
          ? 'APPROVED\nReviewer read the updated file content successfully.'
          : 'Reviewer saw stale file content and cannot approve yet.';
        this.handlers.messageCompleted?.({ type: 'message.completed', sessionId: 'reviewer', at: 5, messageId: 'r1', content: reply });
        this.handlers.turnCompleted?.({ type: 'turn.completed', sessionId: 'reviewer', at: 6, turnId: 'reviewer-turn', stopReason: 'end_turn' });
        return { stopReason: 'end_turn' };
      }
    }

    let reviewerSessions = 0;
    const result = await runAuthorReviewerLoop({
      config: {
        cwd,
        maxRounds: 3,
        trace: false,
        tui: false,
        authorSettings: {
          prompt: ({ round, feedback }: { round: number; feedback: string }) => `author round=${round}; feedback=${feedback || '<none>'}`,
        },
        reviewerSettings: {
          prompt: ({ authorReply }: { authorReply: string }) => `review author=${authorReply}`,
          sessionTurns: 1,
        },
        openRole: async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) => ({
          role,
          session: role === 'AUTHOR' ? new FileAwareSession('AUTHOR') : (reviewerSessions++, new FileAwareSession('REVIEWER')),
        }),
        closeRole: async () => undefined,
      },
      renderer: {},
    });

    expect(result).toMatchObject({ approved: true, rounds: 2 });
    expect(reviewerSessions).toBe(2);
    await expect(fs.readFile(taskFile, 'utf8')).resolves.toBe('after');
    await fs.rm(cwd, { recursive: true, force: true });
  });

  it('replays realistic streamed deltas through the real turn path without splitting words on screen', async () => {
    class StreamingSession {
      private handlers: Record<string, (event: unknown) => void> = {};

      constructor(private readonly role: 'AUTHOR' | 'REVIEWER') {}

      on(handlers: Record<string, (event: unknown) => void>) {
        this.handlers = handlers;
        return () => { this.handlers = {}; };
      }

      async prompt() {
        if (this.role === 'AUTHOR') {
          const events = [
            { type: 'message.delta', sessionId: 'author', at: 1, messageId: 'a1', delta: 'he' },
            { type: 'message.delta', sessionId: 'author', at: 2, messageId: 'a1', delta: 'llo' },
            { type: 'message.delta', sessionId: 'author', at: 3, messageId: 'a1', delta: ' world' },
            { type: 'reasoning.delta', sessionId: 'author', at: 4, reasoningId: 'r1', delta: 'itera' },
            { type: 'reasoning.delta', sessionId: 'author', at: 5, reasoningId: 'r1', delta: 'tion' },
            { type: 'reasoning.delta', sessionId: 'author', at: 6, reasoningId: 'r1', delta: ' plan' },
            { type: 'turn.completed', sessionId: 'author', at: 7, turnId: 'author-turn', stopReason: 'end_turn' },
          ];
          for (const event of events) {
            const key = String((event as { type?: string }).type || '').replace(/\.([a-z])/g, (_match, char: string) => char.toUpperCase());
            this.handlers[key]?.(event);
          }
          return { stopReason: 'end_turn' };
        }

        this.handlers.messageCompleted?.({
          type: 'message.completed',
          sessionId: 'reviewer',
          at: 8,
          messageId: 'r1',
          content: 'APPROVED\nReplay verified: hello world renders without split words.',
        });
        this.handlers.turnCompleted?.({ type: 'turn.completed', sessionId: 'reviewer', at: 9, turnId: 'reviewer-turn', stopReason: 'end_turn' });
        return { stopReason: 'end_turn' };
      }
    }

    const engine = createLoopEngine({
      config: {
        cwd: process.cwd(),
        maxRounds: 1,
        trace: false,
        tui: false,
        authorSettings: {
          prompt: ({ round, feedback }: { round: number; feedback: string }) => `author round=${round}; feedback=${feedback || '<none>'}`,
        },
        reviewerSettings: {
          prompt: ({ authorReply }: { authorReply: string }) => `review author=${authorReply}`,
        },
        openRole: async ({ role }: { role: 'AUTHOR' | 'REVIEWER' }) => ({
          role,
          session: new StreamingSession(role),
        }),
        closeRole: async () => undefined,
      },
    });

    const result = await engine.run();
    const authorPane = engine.getState().rounds.get(1)?.AUTHOR;
    const flowTexts = authorPane?.flow.map((item) => item.text) ?? [];

    expect(result).toMatchObject({ approved: true, rounds: 1 });
    expect(flowTexts).toContain('hello world');
    expect(flowTexts).toContain('iteration plan');
    expect(flowTexts.join('\n')).not.toContain('he llo');
    expect(flowTexts.join('\n')).not.toContain('itera tion');
  });

});
