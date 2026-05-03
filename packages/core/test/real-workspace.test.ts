import { describe, expect, it, vi } from 'vitest';

import {
  ClaudeCode,
  CodexCli,
  enforceRealWorkspaceSession,
  realWorkspacePolicyForAgent,
  realWorkspacePolicyRegistry,
  realWorkspaceSessionModeForAgent,
  withRealWorkspaceDefaults,
} from '../src/index.js';

describe('real-workspace agent policy', () => {
  it('adds Codex launch flags that force real workspace writes by default for adapted profiles', () => {
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

  it('marks Claude Code for bypass permission mode and enforces that mode', async () => {
    const agent = withRealWorkspaceDefaults(ClaudeCode);
    const session = {
      setMode: vi.fn().mockResolvedValue(undefined),
      transcript: { session: { modes: { availableModes: [{ id: 'bypassPermissions' }] } } },
    };
    const emitRoleStatus = vi.fn();

    expect(agent.args).toEqual(ClaudeCode.args);
    expect(agent.env).toMatchObject({ IS_SANDBOX: '1' });
    expect(realWorkspaceSessionModeForAgent(agent)).toBe('bypassPermissions');

    await enforceRealWorkspaceSession({ role: 'AUTHOR', session: session as never, agent, emitRoleStatus });

    expect(session.setMode).toHaveBeenCalledWith('bypassPermissions');
    expect(emitRoleStatus).toHaveBeenCalledWith('session ready, setting real-workspace mode bypassPermissions...');
  });

  it('fails fast when the required real-workspace mode is unavailable', async () => {
    const agent = withRealWorkspaceDefaults(ClaudeCode);
    const session = {
      setMode: vi.fn(),
      transcript: { session: { modes: { availableModes: [{ id: 'ask' }] } } },
    };

    await expect(enforceRealWorkspaceSession({ role: 'REVIEWER', session: session as never, agent }))
      .rejects.toThrow('cannot be forced into real-workspace mode "bypassPermissions"');
    expect(session.setMode).not.toHaveBeenCalled();
  });

  it('keeps policy hooks explicit for every registered agent', () => {
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
    expect(realWorkspacePolicyForAgent(agent)).toBeNull();
    expect(realWorkspaceSessionModeForAgent(agent)).toBeNull();
  });
});
