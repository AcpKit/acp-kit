import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const DEFAULT_IGNORES = new Set(['.git', 'node_modules', '.acp-kit']);
const DEFAULT_MAX_FILES = 80;

export function createWorkspaceChangeTracker({ cwd, execFile = execFileSync, fsImpl = fs, maxFiles = DEFAULT_MAX_FILES } = {}) {
  const root = path.resolve(String(cwd || process.cwd()));
  const before = captureWorkspaceState({ cwd: root, execFile, fsImpl, maxFiles });

  return {
    summarize() {
      const after = captureWorkspaceState({ cwd: root, execFile, fsImpl, maxFiles });
      return summarizeWorkspaceChange({ before, after, maxFiles });
    },
  };
}

export function captureWorkspaceState({ cwd, execFile = execFileSync, fsImpl = fs, maxFiles = DEFAULT_MAX_FILES } = {}) {
  const git = captureGitState({ cwd, execFile });
  if (git) return git;
  return captureFilesystemState({ cwd, fsImpl, maxFiles });
}

export function formatWorkspaceChangeSummary(change) {
  if (!change) return 'Workspace change check unavailable.';
  const backend = change.backend || 'workspace';
  if (change.error) return `Workspace change check (${backend}) unavailable: ${change.error}`;
  const files = Array.isArray(change.files) ? change.files : [];
  if (!change.changed) return `No disk changes detected after AUTHOR turn (${backend}).`;
  const suffix = change.truncated ? ` and ${change.totalFiles - files.length} more` : '';
  return `Disk changes detected after AUTHOR turn (${backend}): ${files.join(', ')}${suffix}`;
}

function captureGitState({ cwd, execFile }) {
  try {
    const inside = runGit(execFile, cwd, ['rev-parse', '--is-inside-work-tree']).trim();
    if (inside !== 'true') return null;
    const status = runGit(execFile, cwd, ['status', '--short']);
    const diffNames = runGit(execFile, cwd, ['diff', '--name-only']);
    const files = uniqueSorted([
      ...parseGitStatusFiles(status),
      ...normalizeLines(diffNames),
    ]);
    return {
      backend: 'git',
      status: normalizeLines(status),
      indexEntries: parseGitIndexEntries(runGit(execFile, cwd, ['ls-files', '-s'])),
      files,
      signatures: gitFileSignatures({ cwd, files }),
    };
  } catch {
    return null;
  }
}

function captureFilesystemState({ cwd, fsImpl, maxFiles }) {
  try {
    const files = [];
    walkFiles({ cwd, dir: cwd, fsImpl, files, maxFiles });
    return { backend: 'filesystem', files: files.sort((a, b) => comparePath(a.path, b.path)) };
  } catch (error) {
    return { backend: 'filesystem', error: error instanceof Error ? error.message : String(error), files: [] };
  }
}

function summarizeWorkspaceChange({ before, after, maxFiles = DEFAULT_MAX_FILES }) {
  if (after?.error) return { backend: after.backend, changed: false, error: after.error, files: [] };
  if (before?.backend === 'git' && after?.backend === 'git') {
    const beforeKey = before.status.join('\n');
    const afterKey = after.status.join('\n');
    const files = uniqueSorted([
      ...(beforeKey !== afterKey ? after.files : []),
      ...changedIndexFiles(before.indexEntries, after.indexEntries),
      ...changedSignatureFiles(before.signatures, after.signatures),
    ]);
    const changed = files.length > 0;
    return limitChangeFiles({ backend: 'git', changed, files, totalFiles: files.length }, maxFiles);
  }

  if (before?.backend === 'filesystem' && after?.backend === 'filesystem') {
    const beforeMap = new Map(before.files.map((item) => [item.path, item.signature]));
    const afterMap = new Map(after.files.map((item) => [item.path, item.signature]));
    const changedFiles = new Set();
    for (const [file, signature] of afterMap) {
      if (beforeMap.get(file) !== signature) changedFiles.add(file);
    }
    for (const file of beforeMap.keys()) {
      if (!afterMap.has(file)) changedFiles.add(file);
    }
    const files = Array.from(changedFiles).sort(comparePath);
    return limitChangeFiles({ backend: 'filesystem', changed: files.length > 0, files, totalFiles: files.length }, maxFiles);
  }

  return { backend: after?.backend || before?.backend || 'workspace', changed: false, error: 'workspace change backend changed during run', files: [] };
}

function limitChangeFiles(change, maxFiles) {
  const limit = Math.max(1, Number(maxFiles) || DEFAULT_MAX_FILES);
  const files = change.files.slice(0, limit);
  return { ...change, files, truncated: change.files.length > files.length };
}

function walkFiles({ cwd, dir, fsImpl, files, maxFiles }) {
  if (files.length >= maxFiles * 20) return;
  for (const entry of fsImpl.readdirSync(dir, { withFileTypes: true })) {
    if (DEFAULT_IGNORES.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(cwd, fullPath).split(path.sep).join('/');
    if (entry.isDirectory()) {
      walkFiles({ cwd, dir: fullPath, fsImpl, files, maxFiles });
      continue;
    }
    if (!entry.isFile()) continue;
    const stat = fsImpl.statSync(fullPath);
    files.push({ path: relPath, signature: `${stat.size}:${Math.trunc(stat.mtimeMs)}` });
  }
}

function runGit(execFile, cwd, args) {
  return String(execFile('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) || '');
}

function parseGitStatusFiles(status) {
  return String(status || '').split(/\r?\n/).filter(Boolean).map((line) => {
    const value = line.length >= 3 ? line.slice(3).trim() : line.trim();
    const rename = value.split(' -> ');
    return rename[rename.length - 1];
  }).filter(Boolean);
}

function parseGitIndexEntries(output) {
  const entries = {};
  for (const line of String(output || '').split(/\r?\n/)) {
    const match = line.match(/^\d+\s+([0-9a-f]+)\s+\d+\t(.+)$/i);
    if (!match) continue;
    entries[match[2]] = match[1];
  }
  return entries;
}

function gitFileSignatures({ cwd, files }) {
  const signatures = {};
  for (const file of files) {
    const fullPath = path.join(cwd, file);
    try {
      const stat = fs.statSync(fullPath);
      if (!stat.isFile()) {
        signatures[file] = '<not-file>';
        continue;
      }
      signatures[file] = createHash('sha256').update(fs.readFileSync(fullPath)).digest('hex');
    } catch {
      signatures[file] = '<missing>';
    }
  }
  return signatures;
}

function changedSignatureFiles(before = {}, after = {}) {
  const files = new Set([...Object.keys(before), ...Object.keys(after)]);
  return Array.from(files).filter((file) => before[file] !== after[file]);
}

function changedIndexFiles(before = {}, after = {}) {
  const files = new Set([...Object.keys(before), ...Object.keys(after)]);
  return Array.from(files).filter((file) => before[file] !== after[file]);
}

function normalizeLines(text) {
  return String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function uniqueSorted(values) {
  return Array.from(new Set(values.filter(Boolean))).sort(comparePath);
}

function comparePath(left, right) {
  const a = String(left);
  const b = String(right);
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
