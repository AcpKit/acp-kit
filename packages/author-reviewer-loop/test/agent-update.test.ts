import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import {
  agentPackageCacheDir,
  formatAgentUpdateHelp,
  resolveAgentUpdatePlan,
  resolveAgentUpdatePackages,
  runAgentUpdateCommand,
  runNpmInstallCachedPackages,
  runNpmInstallPackages,
} from '../lib/cli/agent-update.mjs';

describe('agent update command', () => {
  it('includes supported code agent packages by default', () => {
    expect(resolveAgentUpdatePackages('all')).toEqual([
      '@openai/codex@latest',
      '@anthropic-ai/claude-code@latest',
      '@github/copilot-language-server@latest',
      '@zed-industries/codex-acp@latest',
      '@zed-industries/claude-code-acp@latest',
    ]);
    expect(resolveAgentUpdatePlan('all')).toEqual({
      globalPackages: ['@openai/codex@latest', '@anthropic-ai/claude-code@latest'],
      cachePackages: [
        '@github/copilot-language-server@latest',
        '@zed-industries/codex-acp@latest',
        '@zed-industries/claude-code-acp@latest',
      ],
    });
  });

  it('keeps Copilot in the ACP package cache instead of global installs', () => {
    expect(resolveAgentUpdatePlan('copilot')).toEqual({
      globalPackages: [],
      cachePackages: ['@github/copilot-language-server@latest'],
    });
  });

  it('supports targeted Codex and Claude updates', () => {
    expect(resolveAgentUpdatePlan('codex')).toEqual({
      globalPackages: ['@openai/codex@latest'],
      cachePackages: ['@zed-industries/codex-acp@latest'],
    });
    expect(resolveAgentUpdatePlan('claude')).toEqual({
      globalPackages: ['@anthropic-ai/claude-code@latest'],
      cachePackages: ['@zed-industries/claude-code-acp@latest'],
    });
  });

  it('does not include Gemini, Qwen, or OpenCode in agent updates', () => {
    expect(resolveAgentUpdatePackages('all')).not.toEqual(expect.arrayContaining([
      '@google/gemini-cli@latest',
      '@qwen-code/qwen-code@latest',
      'opencode-ai@latest',
    ]));
  });

  it('prints help without running npm', async () => {
    const log = vi.fn();
    const installGlobalImpl = vi.fn();
    const installCacheImpl = vi.fn();

    await expect(runAgentUpdateCommand({ argv: ['update', 'agents', '--help'], installGlobalImpl, installCacheImpl, log })).resolves.toBe(0);

    expect(installGlobalImpl).not.toHaveBeenCalled();
    expect(installCacheImpl).not.toHaveBeenCalled();
    expect(log.mock.calls.join('\n')).toContain('spar update agents');
    expect(formatAgentUpdateHelp()).toContain('cache @zed-industries/claude-code-acp');
  });

  it('runs global and cache installs for the selected target', async () => {
    const installGlobalImpl = vi.fn().mockResolvedValue({ ok: true, code: 0 });
    const installCacheImpl = vi.fn().mockResolvedValue({ ok: true, code: 0 });
    const log = vi.fn();

    await expect(runAgentUpdateCommand({ argv: ['update', 'agents', 'codex'], installGlobalImpl, installCacheImpl, log })).resolves.toBe(0);

    expect(installGlobalImpl).toHaveBeenCalledWith({ packages: ['@openai/codex@latest'] });
    expect(installCacheImpl).toHaveBeenCalledWith({
      packages: ['@zed-industries/codex-acp@latest'],
      cacheRoot: expect.stringContaining('agent-bin-cache'),
    });
    expect(log.mock.calls.join('\n')).toContain('Agent update complete');
  });

  it('returns a failure for unknown targets', async () => {
    const installGlobalImpl = vi.fn();
    const installCacheImpl = vi.fn();
    const log = vi.fn();

    await expect(runAgentUpdateCommand({ argv: ['update', 'agents', 'missing'], installGlobalImpl, installCacheImpl, log })).resolves.toBe(1);

    expect(installGlobalImpl).not.toHaveBeenCalled();
    expect(installCacheImpl).not.toHaveBeenCalled();
    expect(log.mock.calls.join('\n')).toContain('Unknown agent update target');
  });

  it('spawns npm install -g with package arguments', async () => {
    const child = new EventEmitter();
    const spawnImpl = vi.fn(() => child);
    const promise = runNpmInstallPackages({ packages: ['pkg-a@latest', 'pkg-b@latest'], spawnImpl, stdio: 'pipe' });
    child.emit('close', 0);

    await expect(promise).resolves.toEqual({ ok: true, code: 0 });
    expect(spawnImpl).toHaveBeenCalledWith(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['install', '-g', 'pkg-a@latest', 'pkg-b@latest'],
      { stdio: 'pipe' },
    );
  });

  it('spawns cached npm installs with the same package cache layout as runtime fallback', async () => {
    const spawned = [];
    const spawnImpl = vi.fn(() => {
      const child = new EventEmitter();
      spawned.push(child);
      queueMicrotask(() => child.emit('close', 0));
      return child;
    });

    await expect(runNpmInstallCachedPackages({
      packages: ['@zed-industries/codex-acp@latest', '@github/copilot-language-server@latest'],
      cacheRoot: '/tmp/acp-agent-cache',
      spawnImpl,
      stdio: 'pipe',
    })).resolves.toEqual({ ok: true, code: 0 });

    expect(spawnImpl).toHaveBeenNthCalledWith(1,
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['install', '--prefix', agentPackageCacheDir('@zed-industries/codex-acp@latest', '/tmp/acp-agent-cache'), '--no-audit', '--no-fund', '@zed-industries/codex-acp@latest'],
      { stdio: 'pipe' },
    );
    expect(spawned).toHaveLength(2);
  });
});
