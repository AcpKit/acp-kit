import { describe, expect, it } from 'vitest';
import { Phase } from '../lib/engine.mjs';
import { agents } from '../lib/config/agents.mjs';
import { createFailureDiagnosticBundle, formatFailureDiagnosticBundle } from '../lib/runtime/diagnostic-bundle.mjs';

describe('Spar failure diagnostic bundle', () => {
  it('summarizes config, real-workspace policy, traces, tools, and workspace changes', () => {
    const rounds = new Map([[1, {
      AUTHOR: { tools: [{ id: 't1', title: 'npm test', status: 'failed' }] },
      REVIEWER: { tools: [] },
    }]]);
    const bundle = createFailureDiagnosticBundle({
      config: {
        cwd: '/workspace/project',
        quality: 'prod',
        maxRounds: 2,
        tui: false,
        authorSettings: { agent: agents.codex, model: 'gpt-5.5' },
        reviewerSettings: { agent: agents.claude, model: null },
      },
      runTrace: { enabled: true, filePath: '/tmp/trace.jsonl' },
      recoveryStore: { enabled: true, filePath: '/tmp/recovery.json' },
      recoveryState: { loop: { workspaceChangeSummary: 'Disk changes detected after AUTHOR turn (git): README.md' } },
      state: { phase: Phase.Error, rounds },
      error: new Error('turn failed'),
    });

    expect(bundle.runTracePath).toBe('/tmp/trace.jsonl');
    expect(bundle.recoveryPath).toBe('/tmp/recovery.json');
    expect(bundle.author.realWorkspace.summary).toContain('Codex runs');
    expect(bundle.recentToolCalls).toEqual([{ round: 1, role: 'AUTHOR', title: 'npm test', status: 'failed' }]);

    const formatted = formatFailureDiagnosticBundle(bundle);
    expect(formatted).toContain('run trace: /tmp/trace.jsonl');
    expect(formatted).toContain('workspace changes: Disk changes detected');
    expect(formatted).toContain('recent tools: AUTHOR R1 npm test failed');
  });
});
