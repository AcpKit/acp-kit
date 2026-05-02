import { describe, expect, it } from 'vitest';

import { ClaudeCode, CodexCli } from '@acp-kit/core';
import {
  realWorkspacePolicyForAgent,
  realWorkspaceSessionModeForAgent,
  withRealWorkspaceDefaults,
} from '../lib/runtime/real-workspace.mjs';

describe('Spar real-workspace agent policy', () => {
  it('adds Codex launch flags that force real workspace writes', () => {
    const agent = withRealWorkspaceDefaults(CodexCli);

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
  });

  it('marks Claude Code for bypass permission mode and enables that mode in root containers', () => {
    const agent = withRealWorkspaceDefaults(ClaudeCode);

    expect(agent.args).toEqual(ClaudeCode.args);
    expect(agent.env).toMatchObject({ IS_SANDBOX: '1' });
    expect(realWorkspaceSessionModeForAgent(agent)).toBe('bypassPermissions');
    expect(realWorkspacePolicyForAgent(agent)).toMatchObject({ sessionMode: 'bypassPermissions' });
  });

  it('leaves unknown agents unchanged', () => {
    const agent = { id: 'custom', displayName: 'Custom', command: 'custom-acp', args: ['--x'] };
    expect(withRealWorkspaceDefaults(agent)).toBe(agent);
    expect(realWorkspaceSessionModeForAgent(agent)).toBeNull();
  });
});
