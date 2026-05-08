import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createLocalTerminalHost } from '../../src/hosts/local-terminal.js';

const isWindows = process.platform === 'win32';
const echoCommand = isWindows ? 'cmd.exe' : '/bin/sh';
const echoArgs = (text: string) => (isWindows ? ['/c', `echo ${text}`] : ['-c', `echo ${text}`]);
const failCommand = isWindows ? 'cmd.exe' : '/bin/sh';
const failArgs = isWindows ? ['/c', 'exit 7'] : ['-c', 'exit 7'];
const sleepCommand = isWindows ? 'cmd.exe' : 'sleep';
const sleepArgs = isWindows ? ['/c', 'ping -n 60 127.0.0.1 >nul'] : ['60'];

describe('createLocalTerminalHost', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), 'acp-term-'));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('runs a command and captures stdout', async () => {
    const host = createLocalTerminalHost({ resolveCwd: () => cwd });
    const created = await host.createTerminal({ sessionId: 's', command: echoCommand, args: echoArgs('hello') });
    await host.waitForTerminalExit({ sessionId: 's', terminalId: created.terminalId });
    const out = await host.terminalOutput({ sessionId: 's', terminalId: created.terminalId });
    expect(out.output).toMatch(/hello/);
    await host.releaseTerminal({ sessionId: 's', terminalId: created.terminalId });
  });

  it('runs shell command strings when args are omitted', async () => {
    const host = createLocalTerminalHost({ resolveCwd: () => cwd });
    const command = isWindows ? 'cd && echo hello' : 'pwd && echo hello';
    const created = await host.createTerminal({ sessionId: 's', command });
    const exit = await host.waitForTerminalExit({ sessionId: 's', terminalId: created.terminalId });
    const out = await host.terminalOutput({ sessionId: 's', terminalId: created.terminalId });
    expect(exit.exitCode).toBe(0);
    expect(out.output).toContain(cwd);
    expect(out.output).toMatch(/hello/);
    await host.releaseTerminal({ sessionId: 's', terminalId: created.terminalId });
  });

  it('captures non-zero exit code', async () => {
    const host = createLocalTerminalHost({ resolveCwd: () => cwd });
    const created = await host.createTerminal({ sessionId: 's', command: failCommand, args: failArgs });
    const exit = await host.waitForTerminalExit({ sessionId: 's', terminalId: created.terminalId });
    expect(exit.exitCode).toBe(7);
  });

  it('reports spawn failures as command failures with output', async () => {
    const host = createLocalTerminalHost({ resolveCwd: () => cwd });
    const created = await host.createTerminal({
      sessionId: 's',
      command: 'acp-kit-definitely-missing-terminal-command',
      args: [],
    });
    const exit = await host.waitForTerminalExit({ sessionId: 's', terminalId: created.terminalId });
    const out = await host.terminalOutput({ sessionId: 's', terminalId: created.terminalId });
    expect(exit.exitCode).toBe(127);
    expect(out.output).toMatch(/Failed to start terminal command/);
    expect((out as typeof out & { exitStatus?: { exitCode?: number } }).exitStatus?.exitCode).toBe(127);
    await host.releaseTerminal({ sessionId: 's', terminalId: created.terminalId });
  });

  it('kills a long-running terminal', { timeout: 15000 }, async () => {
    const host = createLocalTerminalHost({ resolveCwd: () => cwd });
    const created = await host.createTerminal({ sessionId: 's', command: sleepCommand, args: sleepArgs });
    await host.killTerminal({ sessionId: 's', terminalId: created.terminalId });
    const exit = await host.waitForTerminalExit({ sessionId: 's', terminalId: created.terminalId });
    expect(exit.exitCode === null || typeof exit.exitCode === 'number').toBe(true);
    await host.releaseTerminal({ sessionId: 's', terminalId: created.terminalId });
  });

  it('release does not kill the underlying process', async () => {
    const host = createLocalTerminalHost({ resolveCwd: () => cwd });
    const created = await host.createTerminal({ sessionId: 's', command: echoCommand, args: echoArgs('bye') });
    // Grab the child process via the escape hatch before release drops it.
    const child = host.terminals.get(created.terminalId);
    expect(child).toBeDefined();
    await host.releaseTerminal({ sessionId: 's', terminalId: created.terminalId });
    expect(host.terminals.get(created.terminalId)).toBeUndefined();
    // child still completes naturally; no assertion about state — just no crash.
    await new Promise<void>((r) => child!.once('close', () => r()));
  });

  it('rejects relative cwd by default', async () => {
    const host = createLocalTerminalHost();
    await expect(
      host.createTerminal({ sessionId: 's', command: echoCommand, args: echoArgs('x') }),
    ).rejects.toThrow(/cwd/);
  });
});
