import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const sparBin = path.join(repoRoot, 'packages/author-reviewer-loop/bin/acp-author-reviewer-loop.mjs');

describe('Spar Codex launch E2E', () => {
  it('runs the real CLI with Codex in real-workspace mode and reviewer sees author disk writes', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'spar-codex-e2e-'));
    const workspace = path.join(tempRoot, 'workspace');
    const fakeBin = path.join(tempRoot, 'bin');
    const home = path.join(tempRoot, 'home');
    const launchLog = path.join(tempRoot, 'codex-launches.jsonl');
    const markerFile = path.join(workspace, 'author-marker.txt');

    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(fakeBin, { recursive: true });
    await fs.mkdir(home, { recursive: true });
    await writeFakeCodexAcp(path.join(fakeBin, 'codex-acp'));

    try {
      const result = await runNode([
        sparBin,
        workspace,
        'Write author-marker.txt so the reviewer can verify real disk visibility.',
        '--yes',
        '--cli',
        '--quality',
        'dev',
      ], {
        cwd: repoRoot,
        env: {
          ...process.env,
          PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`,
          HOME: home,
          SPAR_FAKE_CODEX_LOG: launchLog,
          AUTHOR_AGENT: 'codex',
          REVIEWER_AGENT: 'codex',
          AUTHOR_MODEL: '',
          REVIEWER_MODEL: '',
          AUTHOR_SESSION_TURNS: '1',
          REVIEWER_SESSION_TURNS: '1',
          MAX_ROUNDS: '1',
          SPAR_NO_UPDATE_CHECK: '1',
          SPAR_SESSION_RECORD: '0',
          SPAR_RUN_RECOVERY: '0',
          SPAR_RUN_TRACE: '0',
        },
        timeoutMs: 20_000,
      });

      expect(result.exitCode, result.stderr || result.stdout).toBe(0);
      await expect(fs.readFile(markerFile, 'utf8')).resolves.toBe('author wrote to real disk');

      const entries = await readJsonLines(launchLog);
      const launches = entries.filter((entry) => entry.event === 'launch');
      expect(launches.length).toBeGreaterThanOrEqual(2);
      for (const launch of launches) {
        expect(launch.argv).toEqual(expect.arrayContaining([
          '-c',
          'sandbox_mode="danger-full-access"',
          '-c',
          'approval_policy="never"',
        ]));
      }

      expect(entries).toEqual(expect.arrayContaining([
        expect.objectContaining({ event: 'author-wrote-marker' }),
        expect.objectContaining({ event: 'reviewer-read-marker', content: 'author wrote to real disk' }),
      ]));
      expect(result.stdout).toContain('APPROVED');
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});

async function writeFakeCodexAcp(filePath: string): Promise<void> {
  const source = String.raw`#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const logFile = process.env.SPAR_FAKE_CODEX_LOG;
let nextSession = 1;
const cwdBySession = new Map();

record({ event: 'launch', argv: process.argv.slice(2), cwd: process.cwd() });

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', async (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    process.stderr.write('invalid json: ' + String(error) + '\n');
    return;
  }

  if (!Object.prototype.hasOwnProperty.call(message, 'id')) return;

  try {
    const result = await handleRequest(message.method, message.params || {});
    send({ jsonrpc: '2.0', id: message.id, result });
  } catch (error) {
    send({
      jsonrpc: '2.0',
      id: message.id,
      error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
    });
  }
});

async function handleRequest(method, params) {
  if (method === 'initialize') {
    return {
      protocolVersion: 1,
      agentInfo: { name: 'fake-codex-acp', version: '0.0.0-e2e' },
      agentCapabilities: { loadSession: false, promptCapabilities: {} },
      authMethods: [],
    };
  }

  if (method === 'session/new') {
    const sessionId = 'fake-session-' + nextSession++;
    cwdBySession.set(sessionId, params.cwd || process.cwd());
    record({ event: 'new-session', sessionId, cwd: params.cwd });
    return { sessionId };
  }

  if (method === 'session/set_model') return {};
  if (method === 'session/close') return {};

  if (method === 'session/prompt') {
    const prompt = Array.isArray(params.prompt)
      ? params.prompt.map((part) => part && typeof part.text === 'string' ? part.text : '').join('\n')
      : '';
    const isAuthor = prompt.includes('You are the AUTHOR');
    const sessionCwd = cwdBySession.get(params.sessionId) || process.cwd();
    const markerPath = path.join(sessionCwd, 'author-marker.txt');

    if (isAuthor) {
      fs.writeFileSync(markerPath, 'author wrote to real disk', 'utf8');
      record({ event: 'author-wrote-marker', sessionId: params.sessionId, path: markerPath });
      notify(params.sessionId, 'Wrote author-marker.txt on real disk.');
      return { stopReason: 'end_turn' };
    }

    const content = fs.existsSync(markerPath) ? fs.readFileSync(markerPath, 'utf8') : '<missing>';
    record({ event: 'reviewer-read-marker', sessionId: params.sessionId, path: markerPath, content });
    notify(
      params.sessionId,
      content === 'author wrote to real disk'
        ? 'APPROVED\nReviewer read author-marker.txt from the real workspace.'
        : 'NOT APPROVED: reviewer could not read author-marker.txt from the real workspace.',
    );
    return { stopReason: 'end_turn' };
  }

  throw new Error('Unsupported ACP method: ' + method);
}

function notify(sessionId, text) {
  send({
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
    },
  });
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function record(entry) {
  if (!logFile) return;
  fs.appendFileSync(logFile, JSON.stringify({ ...entry, pid: process.pid }) + '\n', 'utf8');
}
`;
  await writeFakeAgentExecutable(filePath, source);
}

async function writeFakeAgentExecutable(filePath: string, source: string): Promise<void> {
  if (process.platform !== 'win32') {
    await fs.writeFile(filePath, source, { mode: 0o755 });
    return;
  }

  const scriptPath = `${filePath}.mjs`;
  await fs.writeFile(scriptPath, source, 'utf8');
  await fs.writeFile(
    `${filePath}.cmd`,
    `@echo off\r\n"${process.execPath}" "%~dp0${path.basename(scriptPath)}" %*\r\n`,
    'utf8',
  );
}

function runNode(args: string[], options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Timed out after ${options.timeoutMs}ms\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, options.timeoutMs);
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timeout);
      resolve({ exitCode, signal, stdout, stderr });
    });
  });
}

async function readJsonLines(filePath: string): Promise<Array<Record<string, unknown>>> {
  const content = await fs.readFile(filePath, 'utf8');
  return content
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
