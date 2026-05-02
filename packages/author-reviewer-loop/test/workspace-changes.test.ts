import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

import { createWorkspaceChangeTracker, formatWorkspaceChangeSummary } from '../lib/runtime/workspace-changes.mjs';

const TEMP_DIRS: string[] = [];

afterEach(() => {
  while (TEMP_DIRS.length > 0) {
    const dir = TEMP_DIRS.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spar-workspace-changes-'));
  TEMP_DIRS.push(dir);
  return dir;
}

function git(cwd: string, args: string[]) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
}

describe('workspace change detection', () => {
  it('uses real git status and diff state to report author disk changes', () => {
    const cwd = tempDir();
    git(cwd, ['init']);
    fs.writeFileSync(path.join(cwd, 'README.md'), 'before\n', 'utf8');
    git(cwd, ['add', 'README.md']);
    git(cwd, ['-c', 'user.name=Spar Test', '-c', 'user.email=spar@example.test', 'commit', '-m', 'initial']);

    const tracker = createWorkspaceChangeTracker({ cwd });
    fs.writeFileSync(path.join(cwd, 'README.md'), 'after\n', 'utf8');
    fs.writeFileSync(path.join(cwd, 'new.txt'), 'new\n', 'utf8');

    const change = tracker.summarize();

    expect(change).toMatchObject({ backend: 'git', changed: true });
    expect(change.files).toEqual(['README.md', 'new.txt']);
    expect(formatWorkspaceChangeSummary(change)).toContain('Disk changes detected after AUTHOR turn (git): README.md, new.txt');
  });

  it('reports no git disk changes when the author does not modify the working tree', () => {
    const cwd = tempDir();
    git(cwd, ['init']);
    fs.writeFileSync(path.join(cwd, 'README.md'), 'stable\n', 'utf8');
    git(cwd, ['add', 'README.md']);
    git(cwd, ['-c', 'user.name=Spar Test', '-c', 'user.email=spar@example.test', 'commit', '-m', 'initial']);

    const tracker = createWorkspaceChangeTracker({ cwd });
    const change = tracker.summarize();

    expect(change).toMatchObject({ backend: 'git', changed: false, files: [] });
    expect(formatWorkspaceChangeSummary(change)).toBe('No disk changes detected after AUTHOR turn (git).');
  });

  it('detects content changes to files that were already dirty before the author turn', () => {
    const cwd = tempDir();
    git(cwd, ['init']);
    fs.writeFileSync(path.join(cwd, 'README.md'), 'clean\n', 'utf8');
    git(cwd, ['add', 'README.md']);
    git(cwd, ['-c', 'user.name=Spar Test', '-c', 'user.email=spar@example.test', 'commit', '-m', 'initial']);
    fs.writeFileSync(path.join(cwd, 'README.md'), 'dirty before\n', 'utf8');

    const tracker = createWorkspaceChangeTracker({ cwd });
    fs.writeFileSync(path.join(cwd, 'README.md'), 'dirty after author\n', 'utf8');

    const change = tracker.summarize();

    expect(change).toMatchObject({ backend: 'git', changed: true });
    expect(change.files).toEqual(['README.md']);
  });

  it('detects git changes even when the author commits and leaves a clean working tree', () => {
    const cwd = tempDir();
    git(cwd, ['init']);
    fs.writeFileSync(path.join(cwd, 'README.md'), 'before\n', 'utf8');
    git(cwd, ['add', 'README.md']);
    git(cwd, ['-c', 'user.name=Spar Test', '-c', 'user.email=spar@example.test', 'commit', '-m', 'initial']);

    const tracker = createWorkspaceChangeTracker({ cwd });
    fs.writeFileSync(path.join(cwd, 'README.md'), 'after\n', 'utf8');
    git(cwd, ['add', 'README.md']);
    git(cwd, ['-c', 'user.name=Spar Test', '-c', 'user.email=spar@example.test', 'commit', '-m', 'author change']);

    const change = tracker.summarize();

    expect(git(cwd, ['status', '--short'])).toBe('');
    expect(change).toMatchObject({ backend: 'git', changed: true });
    expect(change.files).toEqual(['README.md']);
  });

  it('falls back to filesystem snapshots outside git repositories', () => {
    const cwd = tempDir();
    fs.writeFileSync(path.join(cwd, 'a.txt'), 'a\n', 'utf8');
    const tracker = createWorkspaceChangeTracker({ cwd });

    fs.writeFileSync(path.join(cwd, 'a.txt'), 'changed\n', 'utf8');
    fs.mkdirSync(path.join(cwd, 'nested'));
    fs.writeFileSync(path.join(cwd, 'nested', 'b.txt'), 'b\n', 'utf8');

    const change = tracker.summarize();

    expect(change).toMatchObject({ backend: 'filesystem', changed: true });
    expect(change.files).toEqual(['a.txt', 'nested/b.txt']);
  });
});
