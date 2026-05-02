import { describe, expect, it } from 'vitest';

import { ClaudeCode, CodexCli } from '@acp-kit/core';
import {
  realWorkspacePolicyRegistry,
  realWorkspacePolicyForAgent,
  realWorkspaceSessionModeForAgent,
  withRealWorkspaceDefaults,
} from '../lib/runtime/real-workspace.mjs';

describe('Spar real-workspace agent policy', () => {
  it('adds Codex launch flags that force real workspace writes', () => {
    const agent = withRealWorkspaceDefaults(CodexCli);
    const policy = realWorkspacePolicyRegistry['codex-cli'];

    expect(agent.args).toEqual(expect.arrayContaining([
      '-c',
      'sandbox_mode="danger-full-access"',
      '-c',
      'approval_policy="never"',
    ]));
    expect(agent.fallbackCommands?.[0]?.args).toEqual(expect.arrayContaining([
      '-c',
      'sandbox_mode="danger-full-access"',
      '-c',
      'approval_policy="never"',
    ]));
    expect(policy.diagnosticsSummary()).toMatchObject({
      launchArgs: expect.arrayContaining(['sandbox_mode="danger-full-access"', 'approval_policy="never"']),
      summary: expect.stringContaining('Codex runs'),
    });
  });

  it('marks Claude Code for bypass permission mode and enables that mode in root containers', () => {
    const agent = withRealWorkspaceDefaults(ClaudeCode);
    const policy = realWorkspacePolicyForAgent(agent);

    expect(agent.args).toEqual(ClaudeCode.args);
    expect(agent.env).toMatchObject({ IS_SANDBOX: '1' });
    expect(realWorkspaceSessionModeForAgent(agent)).toBe('bypassPermissions');
    expect(policy).toMatchObject({ sessionMode: 'bypassPermissions' });
    expect(policy?.diagnosticsSummary()).toMatchObject({
      env: { IS_SANDBOX: '1' },
      sessionMode: 'bypassPermissions',
      summary: expect.stringContaining('Claude Code runs'),
    });
  });

  it('keeps real-workspace policy hooks explicit for every registered agent', () => {
    for (const policy of Object.values(realWorkspacePolicyRegistry)) {
      expect(policy).toEqual(expect.objectContaining({
        adaptLaunchProfile: expect.any(Function),
        setupSession: expect.any(Function),
        diagnosticsSummary: expect.any(Function),
      }));
    }
  });

  it('leaves unknown agents unchanged', () => {
    const agent = { id: 'custom', displayName: 'Custom', command: 'custom-acp', args: ['--x'] };
    expect(withRealWorkspaceDefaults(agent)).toBe(agent);
    expect(realWorkspaceSessionModeForAgent(agent)).toBeNull();
  });
});
