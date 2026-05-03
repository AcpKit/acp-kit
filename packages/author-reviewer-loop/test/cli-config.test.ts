import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseRunConfig } from '../lib/cli/config.mjs';
import { formatStartupError } from '../lib/cli/error.mjs';
import { agents, modelChoicesForAgent } from '../lib/config/agents.mjs';
import { preferencesFilePath, readPreferences, writePreferences } from '../lib/config/preferences.mjs';
import { formatRunSummary } from '../lib/cli/summary.mjs';
import { commitSetupSelections, parseEditorCommand } from '../lib/renderers/tui.mjs';

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_CWD = process.cwd();
const TEMP_DIRS: string[] = [];
const CLI_BIN = path.resolve('packages', 'author-reviewer-loop', 'bin', 'acp-author-reviewer-loop.mjs');
const PACKAGE_VERSION = JSON.parse(fs.readFileSync(path.resolve('packages', 'author-reviewer-loop', 'package.json'), 'utf8')).version;

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.AUTHOR_AGENT;
  delete process.env.AUTHOR_MODEL;
  delete process.env.REVIEWER_AGENT;
  delete process.env.REVIEWER_MODEL;
  delete process.env.AUTHOR_SESSION_TURNS;
  delete process.env.REVIEWER_SESSION_TURNS;
  delete process.env.SPAR_QUALITY;
  delete process.env.SPAR_REAL_WORKSPACE;
  delete process.env.ACP_REVIEW_CLI;
  delete process.env.ACP_REVIEW_TUI;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  process.chdir(ORIGINAL_CWD);
  while (TEMP_DIRS.length > 0) {
    const dir = TEMP_DIRS.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'author-reviewer-loop-'));
  TEMP_DIRS.push(dir);
  return dir;
}

function parseConfig(argv, preferences = {}) {
  return parseRunConfig({ argv, preferences });
}

describe('author-reviewer-loop CLI config', () => {
  it('prints the package version from the installed CLI entry point', () => {
    for (const flag of ['--version', '-v']) {
      const result = spawnSync(process.execPath, [CLI_BIN, flag], {
        cwd: ORIGINAL_CWD,
        encoding: 'utf8',
        env: { ...process.env, SPAR_NO_UPDATE_CHECK: '1' },
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe(PACKAGE_VERSION);
      expect(result.stderr).toBe('');
    }
  });

  it('prints help using the installed spar command name', () => {
    const result = spawnSync(process.execPath, [CLI_BIN, '--help'], {
      cwd: ORIGINAL_CWD,
      encoding: 'utf8',
      env: { ...process.env, SPAR_NO_UPDATE_CHECK: '1' },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Usage: spar <cwd> <task-or-task-file...> [--yes] [--cli] [--quality prod|dev]');
    expect(result.stdout).toContain('-v, --version');
    expect(result.stdout).toContain('--doctor');
    expect(result.stdout).toContain('--danger-ignore-approval');
    expect(result.stdout).toContain('--no-real-workspace');
    expect(result.stderr).toBe('');
  });

  it('uses the TUI renderer by default and --cli opts into the plain renderer', () => {
    const cwd = tempDir();

    expect(parseConfig([cwd, 'Build the thing', '--yes']).tui).toBe(true);
    expect(parseConfig([cwd, 'Build the thing', '--yes', '--cli']).tui).toBe(false);

    process.env.ACP_REVIEW_CLI = '1';
    expect(parseConfig([cwd, 'Build the thing', '--yes']).tui).toBe(false);
  });

  it('lets doctor run without task text and uses CLI defaults for diagnostics', () => {
    const cwd = tempDir();
    const config = parseConfig([cwd, '--doctor']);

    expect(config.doctor).toBe(true);
    expect(config.tui).toBe(false);
    expect(config.task).toBe('');
    expect(config.authorSettings.agentId).toBe('copilot');
    expect(config.reviewerSettings.agentId).toBe('codex');
  });

  it('gives explicit renderer flags precedence over compatibility environment flags', () => {
    const cwd = tempDir();

    process.env.ACP_REVIEW_TUI = '1';
    expect(parseConfig([cwd, 'Build the thing', '--yes', '--cli']).tui).toBe(false);

    process.env.ACP_REVIEW_CLI = '1';
    delete process.env.ACP_REVIEW_TUI;
    expect(parseConfig([cwd, 'Build the thing', '--yes', '--tui']).tui).toBe(true);
  });

  it('lets the TUI compatibility environment flag override CLI environment mode', () => {
    const cwd = tempDir();

    process.env.ACP_REVIEW_CLI = '1';
    process.env.ACP_REVIEW_TUI = '1';

    expect(parseConfig([cwd, 'Build the thing', '--yes']).tui).toBe(true);
  });

  it('does not apply built-in author/reviewer agent defaults in TUI mode', () => {
    const config = parseConfig([tempDir(), 'Build the thing', '--yes']);

    expect(config.tui).toBe(true);
    expect(config.authorSettings.agent).toBeNull();
    expect(config.authorSettings.agentSource).toBe('unset');
    expect(config.reviewerSettings.agent).toBeNull();
    expect(config.reviewerSettings.agentSource).toBe('unset');
  });

  it('uses saved preferences before built-in defaults and below environment variables', () => {
    const preferences = {
      author: { agent: 'claude', model: 'opus' },
      reviewer: { agent: 'copilot', model: 'claude-opus-4.7' },
    };

    const fromConfig = parseConfig([tempDir(), 'Build the thing', '--yes'], preferences);
    expect(fromConfig.authorSettings.agentId).toBe('claude');
    expect(fromConfig.authorSettings.model).toBe('opus');
    expect(fromConfig.authorSettings.agentSource).toBe('config');

    process.env.AUTHOR_AGENT = 'codex';
    process.env.AUTHOR_MODEL = 'gpt-5.5';
    const fromEnv = parseConfig([tempDir(), 'Build the thing', '--yes'], preferences);
    expect(fromEnv.authorSettings.agentId).toBe('codex');
    expect(fromEnv.authorSettings.model).toBe('gpt-5.5');
    expect(fromEnv.authorSettings.agentSource).toBe('env');
    expect(fromEnv.reviewerSettings.agentId).toBe('copilot');
  });

  it('reads saved preferences from disk when no injected preferences are provided', () => {
    const preferencesPath = path.join(tempDir(), '.acp-author-reviewer-loop.json');
    fs.writeFileSync(preferencesPath, JSON.stringify({
      author: { agent: 'claude', model: 'opus' },
      reviewer: { agent: 'codex', model: 'gpt-5.5' },
    }), 'utf8');

    const config = parseRunConfig({ argv: [tempDir(), 'Build the thing', '--yes'], preferencesPath });

    expect(config.authorSettings.agentId).toBe('claude');
    expect(config.authorSettings.model).toBe('opus');
    expect(config.reviewerSettings.agentId).toBe('codex');
    expect(config.reviewerSettings.model).toBe('gpt-5.5');
  });

  it('stores the default preferences file under the ACP Kit Spar directory', () => {
    expect(preferencesFilePath()).toBe(path.join(os.homedir(), '.acp-kit', 'spar', 'preferences.json'));
    expect(preferencesFilePath({ home: '/tmp/spar-home' })).toBe(path.join('/tmp/spar-home', '.acp-kit', 'spar', 'preferences.json'));
  });

  it('reports invalid saved config using the actual preferences file path', () => {
    const preferencesPath = path.join(tempDir(), '.acp-author-reviewer-loop.json');
    fs.writeFileSync(preferencesPath, JSON.stringify({
      author: { agent: 'missing-agent', model: 'opus' },
    }), 'utf8');

    expect(() => parseRunConfig({
      argv: [tempDir(), 'Build the thing', '--yes', '--cli'],
      preferencesPath,
    })).toThrow(`author.agent in ${preferencesPath}=missing-agent is not supported`);
  });

  it('writes normalized preferences to the requested config file', () => {
    const filePath = path.join(tempDir(), 'nested', '.acp-author-reviewer-loop.json');

    writePreferences({
      author: { agent: 'CLAUDE', model: 'opus' },
      reviewer: { agent: ' codex ', model: '' },
    }, { filePath });

    expect(readPreferences({ filePath })).toEqual({
      author: { agent: 'claude', model: 'opus' },
      reviewer: { agent: 'codex', model: null },
    });
  });

  it('writes default preferences into the ACP Kit Spar directory', () => {
    const home = tempDir();
    const filePath = preferencesFilePath({ home });

    writePreferences({ author: { agent: 'codex', model: 'gpt-5.5' } }, { filePath });

    expect(fs.existsSync(filePath)).toBe(true);
    expect(readPreferences({ filePath })).toMatchObject({ author: { agent: 'codex', model: 'gpt-5.5' } });
  });

  it('replaces an existing preferences file when saving updates', () => {
    const filePath = path.join(tempDir(), 'nested', '.acp-author-reviewer-loop.json');

    writePreferences({
      author: { agent: 'claude', model: 'opus' },
      reviewer: { agent: 'codex', model: 'gpt-5.4' },
    }, { filePath });
    writePreferences({
      author: { agent: 'copilot', model: 'gpt-5.5' },
      reviewer: { agent: 'claude', model: null },
    }, { filePath });

    expect(readPreferences({ filePath })).toEqual({
      author: { agent: 'copilot', model: 'gpt-5.5' },
      reviewer: { agent: 'claude', model: null },
    });
  });

  it('keeps CLI mode backward-compatible with built-in defaults', () => {
    const config = parseConfig([tempDir(), 'Build the thing', '--yes', '--cli']);

    expect(config.authorSettings.agentId).toBe('copilot');
    expect(config.authorSettings.model).toBe('gpt-5.4');
    expect(config.reviewerSettings.agentId).toBe('codex');
    expect(config.reviewerSettings.model).toBe('gpt-5.5');
  });

  it('parses danger-ignore-approval as invocation-only state', () => {
    const config = parseConfig([tempDir(), 'Build the thing', '--yes', '--cli', '--danger-ignore-approval']);
    const savePreferences = vi.fn();

    expect(config.dangerIgnoreApproval).toBe(true);

    commitSetupSelections(config, {
      selections: {
        authorAgentId: 'copilot',
        authorModel: 'gpt-5.4',
        reviewerAgentId: 'codex',
        reviewerModel: 'gpt-5.5',
        save: true,
      },
    }, { savePreferences });

    expect(savePreferences.mock.calls[0][0]).not.toHaveProperty('dangerIgnoreApproval');
  });

  it('defaults to 20 rounds, 20-turn role sessions, and wrap enabled in TUI mode', () => {
    const config = parseConfig([tempDir(), 'Build the thing', '--yes']);

    expect(config.maxRounds).toBe(20);
    expect(config.quality).toBe('prod');
    expect(config.authorSettings.sessionTurns).toBe(20);
    expect(config.reviewerSettings.sessionTurns).toBe(20);
    expect(config.wrap).toBe(true);
  });

  it('supports dev quality through environment and lets the CLI flag override it', () => {
    process.env.SPAR_QUALITY = 'dev';
    expect(parseConfig([tempDir(), 'Build the thing', '--yes']).quality).toBe('dev');

    process.env.SPAR_QUALITY = 'prod';
    expect(parseConfig([tempDir(), 'Build the thing', '--yes', '--quality', 'dev']).quality).toBe('dev');
  });

  it('rejects unsupported quality values', () => {
    process.env.SPAR_QUALITY = 'fast';

    expect(() => parseConfig([tempDir(), 'Build the thing', '--yes'])).toThrow('Invalid quality "fast". Use "prod" or "dev".');
  });

  it('reads independent role session turn limits from environment variables', () => {
    process.env.AUTHOR_SESSION_TURNS = '5';
    process.env.REVIEWER_SESSION_TURNS = '10';

    const config = parseConfig([tempDir(), 'Build the thing', '--yes']);

    expect(config.authorSettings.sessionTurns).toBe(5);
    expect(config.reviewerSettings.sessionTurns).toBe(10);
  });

  it('rejects invalid role session turn limits instead of silently falling back', () => {
    process.env.AUTHOR_SESSION_TURNS = '0';
    expect(() => parseConfig([tempDir(), 'Build the thing', '--yes'])).toThrow('AUTHOR_SESSION_TURNS must be a positive integer.');

    process.env.AUTHOR_SESSION_TURNS = '5';
    process.env.REVIEWER_SESSION_TURNS = '2.5';
    expect(() => parseConfig([tempDir(), 'Build the thing', '--yes'])).toThrow('REVIEWER_SESSION_TURNS must be a positive integer.');
  });

  it('lets explicit wrap environment flags override the default TUI wrap state', () => {
    process.env.ACP_REVIEW_WRAP = '1';
    expect(parseConfig([tempDir(), 'Build the thing', '--yes']).wrap).toBe(true);

    process.env.ACP_REVIEW_WRAP = '0';
    expect(parseConfig([tempDir(), 'Build the thing', '--yes']).wrap).toBe(false);
  });

  it('keeps non-predefined models as selectable custom model choices', () => {
    const choices = modelChoicesForAgent('copilot', 'local-custom-model');

    expect(choices[0]).toMatchObject({
      label: 'local-custom-model (custom)',
      value: 'local-custom-model',
      custom: true,
    });
    expect(choices.map((choice) => choice.value)).toContain('gpt-5.4');
  });

  it('uses the supported Codex model variants', () => {
    expect(modelChoicesForAgent('codex').map((choice) => choice.value)).toEqual([
      'gpt-5.5',
      'gpt-5.4/xhigh',
      'gpt-5.4/high',
      'gpt-5.4/medium',
    ]);
  });

  it('uses the supported Claude Code model variants', () => {
    expect(modelChoicesForAgent('claude').map((choice) => choice.value)).toEqual([
      'claude-opus-4-7-1m',
      'claude-opus-4-7',
      'opus',
      null,
    ]);
  });

  it('runs Codex through Spar with real-workspace launch defaults', () => {
    const expectedArgs = [
      '-c', 'sandbox_mode="danger-full-access"',
      '-c', 'approval_policy="never"',
    ];

    expect(agents.codex.command).toBe('codex-acp');
    expect(agents.codex.args).toEqual(expectedArgs);
    expect(agents.codex.fallbackCommands?.[0]?.args).toEqual([
      '--yes', '@zed-industries/codex-acp@latest', ...expectedArgs,
    ]);
  });

  it('requires an explicit opt-out to disable real-workspace launch defaults', () => {
    const enabled = parseConfig([tempDir(), 'Build the thing', '--yes', '--cli']);
    expect(enabled.realWorkspace).toBe(true);
    expect(enabled.reviewerSettings.agent.args).toEqual(expect.arrayContaining([
      'sandbox_mode="danger-full-access"',
      'approval_policy="never"',
    ]));

    const disabled = parseConfig([tempDir(), 'Build the thing', '--yes', '--cli', '--no-real-workspace']);
    expect(disabled.realWorkspace).toBe(false);
    expect(disabled.reviewerSettings.agent.args).toEqual([]);
    expect(disabled.reviewerSettings.agent.fallbackCommands?.[0]?.args).toEqual(['--yes', '@zed-industries/codex-acp@latest']);
  });

  it('lets SPAR_REAL_WORKSPACE=0 explicitly disable real-workspace defaults', () => {
    process.env.SPAR_REAL_WORKSPACE = '0';

    const config = parseConfig([tempDir(), 'Build the thing', '--yes', '--cli']);

    expect(config.realWorkspace).toBe(false);
    expect(config.reviewerSettings.agent.args).toEqual([]);
  });

  it('reports invalid startup config through the CLI formatter', () => {
    const error = new Error('AUTHOR_AGENT=missing-agent is not supported. Use one of: claude, codex, copilot, gemini, opencode, qwen.');
    error.name = 'ConfigurationError';

    const formatted = formatStartupError(error);

    expect(formatted).toContain('AUTHOR_AGENT=missing-agent is not supported');
    expect(formatted).not.toContain('at envChoice');
    expect(formatted.startsWith('Error: ')).toBe(true);
  });

  it('expands aggregate run and cleanup errors for actionable CLI output', () => {
    const error = new AggregateError([
      new Error('RequestError: Internal error'),
      new Error('session.close failed'),
    ], 'Author-reviewer loop failed and cleanup also failed.');

    const formatted = formatStartupError(error);

    expect(formatted).toContain('Author-reviewer loop failed and cleanup also failed.');
    expect(formatted).toContain('Cause 1: Error: RequestError: Internal error');
    expect(formatted).toContain('Cause 2: Error: session.close failed');
  });

  it('resolves relative and absolute task files once at startup', () => {
    const cwd = tempDir();
    const taskFile = path.join(cwd, 'task with spaces.txt');
    fs.writeFileSync(taskFile, 'file task\nwith details', 'utf8');

    process.chdir(cwd);
    const relative = parseConfig([cwd, 'task with spaces.txt', '--yes', '--cli']);
    const absolute = parseConfig([cwd, taskFile, '--yes', '--cli']);

    fs.writeFileSync(taskFile, 'changed later', 'utf8');

    expect(relative.task).toBe('file task\nwith details');
    expect(relative.taskSource).toEqual({ kind: 'file', path: taskFile });
    expect(absolute.task).toBe('file task\nwith details');
    expect(absolute.taskSource).toEqual({ kind: 'file', path: taskFile });
  });

  it('keeps inline text when the task value is not a readable file', () => {
    const cwd = tempDir();
    const config = parseConfig([cwd, 'Create docs for missing-file.txt', '--yes', '--cli']);

    expect(config.task).toBe('Create docs for missing-file.txt');
    expect(config.taskSource).toEqual({ kind: 'text' });
  });

  it('resolves relative task files against the requested workspace instead of the launcher cwd', () => {
    const cwd = tempDir();
    const launcherCwd = tempDir();
    const taskFile = path.join(cwd, 'task.txt');
    fs.writeFileSync(taskFile, 'workspace task', 'utf8');

    process.chdir(launcherCwd);
    const config = parseConfig([cwd, 'task.txt', '--yes', '--cli']);

    expect(config.task).toBe('workspace task');
    expect(config.taskSource).toEqual({ kind: 'file', path: taskFile });
  });
  it('formats the full task in the confirmation summary', () => {
    const task = ['first line', 'second line', 'third line'].join('\n');
    const config = parseConfig([tempDir(), task, '--yes', '--cli']);

    expect(formatRunSummary(config)).toContain(`task:           ${task}`);
    expect(formatRunSummary(config)).toContain('real workspace: enabled');
  });

  it('formats explicit real-workspace opt-out in the confirmation summary', () => {
    const config = parseConfig([tempDir(), 'build it', '--yes', '--cli', '--no-real-workspace']);

    expect(formatRunSummary(config)).toContain('real workspace: disabled');
  });

  it('uses edited task text in future prompts', () => {
    const config = parseConfig([tempDir(), 'original task', '--yes', '--cli']);

    config.task = 'edited task';

    expect(config.authorSettings.prompt({ round: 1, feedback: '' })).toContain('Task: edited task');
    expect(config.authorSettings.prompt({ round: 2, feedback: 'fix it' })).toContain('Current task: edited task');
    expect(config.reviewerSettings.prompt({ round: 1, feedback: '' })).toContain('Original task: edited task');
  });

  it('gives the author a structured production-grade testing brief', () => {
    const config = parseConfig([tempDir(), 'build it', '--yes', '--cli']);
    const prompt = config.authorSettings.prompt({ round: 1, feedback: '' });

    expect(prompt).toContain('Mission: deliver a production-grade result where passing tests means the user experience is ready for handoff');
    expect(prompt).toContain('meaningful unit, integration, scenario/use-case, and realistic end-to-end tests');
    expect(prompt).toContain('Think like a hostile tester first and identify 5-10 failure cases');
    expect(prompt).toContain('unpredictable or malformed LLM output');
    expect(prompt).toContain('contradictory reviewer guidance');
    expect(prompt).toContain('Do not write vanity tests');
    expect(prompt).toContain('If testing exposes a real bug, fix the root cause correctly');
    expect(prompt).toContain('Create or update an adversarial scenario analysis report');
    expect(prompt).toContain('Do not paste code');
  });

  it('keeps the production-grade bar in follow-up author prompts', () => {
    const config = parseConfig([tempDir(), 'build it', '--yes', '--cli']);
    const prompt = config.authorSettings.prompt({ round: 2, feedback: '1. Missing recovery test' });

    expect(prompt).toContain('REVIEWER feedback:\n1. Missing recovery test');
    expect(prompt).toContain('Address every reviewer point in code, tests, docs, or behavior as needed');
    expect(prompt).toContain('Keep the same production-grade bar from the first round');
    expect(prompt).toContain('huge inputs');
    expect(prompt).toContain('existing project checks when practical');
  });

  it('uses a lighter author prompt in dev quality', () => {
    const config = parseConfig([tempDir(), 'build it', '--yes', '--cli', '--quality', 'dev']);
    const firstPrompt = config.authorSettings.prompt({ round: 1, feedback: '' });
    const followUpPrompt = config.authorSettings.prompt({ round: 2, feedback: '1. Missing validation' });

    expect(firstPrompt).toContain('Work on the task using your code agent tools.');
    expect(firstPrompt).toContain('Inspect the relevant project files and existing patterns.');
    expect(firstPrompt).toContain('Implement the changes needed to complete the task.');
    expect(firstPrompt).toContain('Run relevant validation when practical.');
    expect(followUpPrompt).toContain('REVIEWER feedback:\n1. Missing validation');
    expect(followUpPrompt).toContain('Continue the task using your code agent tools.');
    expect(followUpPrompt).toContain('Apply the changes needed to address the feedback.');
  });

  it('includes round and previous feedback in reviewer prompts', () => {
    const config = parseConfig([tempDir(), 'build it', '--yes', '--cli']);
    const prompt = config.reviewerSettings.prompt({ round: 2, feedback: '1. Missing tests' });

    expect(prompt).toContain('Round: 2');
    expect(prompt).toContain('Previous reviewer feedback:\n1. Missing tests');
  });

  it("includes the AUTHOR's reply in the reviewer prompt when provided", () => {
    const config = parseConfig([tempDir(), 'build it', '--yes', '--cli']);
    const prompt = config.reviewerSettings.prompt({
      round: 3,
      feedback: '',
      authorReply: 'I edited foo.ts and bar.ts to add validation.',
    });

    expect(prompt).toContain("AUTHOR's reply for this round");
    expect(prompt).toContain('I edited foo.ts and bar.ts to add validation.');
    expect(prompt).toContain('Use the AUTHOR reply as a report of claimed work, not as evidence.');
    expect(prompt).toContain('Double-check claimed changes against the actual project files before judging.');
    expect(prompt).toContain('If this workspace is a git repository, git status/diff can help identify changes');
    expect(prompt).toContain('if it is not a git repository, inspect the relevant files directly instead.');
    expect(prompt).toContain('if you list any remaining issue, required fix, uncertainty, blocker, missing validation, regression risk, or unresolved concern anywhere in your review, your final verdict MUST be SPAR_VERDICT: REJECTED');
    expect(prompt).toContain('Never output SPAR_VERDICT: APPROVED in the same reply as unresolved issue text.');
    expect(prompt).toContain('Review the current project state and relevant modifications as a whole');
    expect(prompt).toContain('not only the files or summary mentioned by the AUTHOR');
    expect(prompt).toContain('translated the quality bar into concrete execution');
    expect(prompt).toContain('meaningful tests, adversarial coverage, realistic fixtures, and correct bug fixes');
  });

  it('asks the reviewer for actionable fix guidance', () => {
    const config = parseConfig([tempDir(), 'build it', '--yes', '--cli']);
    const prompt = config.reviewerSettings.prompt({ round: 1, feedback: '', authorReply: 'changed files' });

    expect(prompt).toContain('concrete fix guidance');
    expect(prompt).toContain('Prefer actionable suggestions over questions');
    expect(prompt).toContain('Reject vanity tests, over-idealized mocks');
    expect(prompt).toContain('the tests are genuinely convincing');
  });

  it('uses task-completion review criteria in dev quality', () => {
    const config = parseConfig([tempDir(), 'build it', '--yes', '--cli', '--quality', 'dev']);
    const prompt = config.reviewerSettings.prompt({ round: 1, feedback: '', authorReply: 'changed files' });

    expect(prompt).toContain('Inspect the relevant project state');
    expect(prompt).toContain('Review whether the task is completed.');
    expect(prompt).toContain('The requested behavior is implemented.');
    expect(prompt).toContain('Relevant validation was run when practical.');
    expect(prompt).toContain('SPAR_VERDICT: APPROVED');
    expect(prompt).toContain('SPAR_VERDICT: REJECTED');
    expect(prompt).toContain('Use SPAR_VERDICT: REJECTED when concrete fixes are still needed.');
  });

  it('commits TUI selections to the configured preferences path while preserving env-locked sources', () => {
    process.env.AUTHOR_AGENT = 'claude';
    process.env.AUTHOR_MODEL = 'opus';
    const config = parseConfig([tempDir(), 'Build the thing', '--yes']);
    config.preferencesPath = path.join(tempDir(), '.custom-prefs.json');
    const savePreferences = vi.fn();

    commitSetupSelections(config, {
      selections: {
        authorAgentId: 'copilot',
        authorModel: 'gpt-5.4',
        reviewerAgentId: 'codex',
        reviewerModel: 'gpt-5.5',
        save: true,
      },
    }, { savePreferences });

    expect(config.authorSettings.agentId).toBe('claude');
    expect(config.authorSettings.model).toBe('opus');
    expect(config.authorSettings.agentSource).toBe('env');
    expect(config.authorSettings.modelSource).toBe('env');
    expect(config.reviewerSettings.agentId).toBe('codex');
    expect(config.reviewerSettings.model).toBe('gpt-5.5');
    expect(config.reviewerSettings.agentSource).toBe('tui');
    expect(config.reviewerSettings.modelSource).toBe('tui');
    expect(savePreferences).toHaveBeenCalledWith({
      author: { agent: 'copilot', model: 'gpt-5.4' },
      reviewer: { agent: 'codex', model: 'gpt-5.5' },
    }, {
      filePath: config.preferencesPath,
    });
  });

  it('lets TUI selections persist a free-form custom model', () => {
    const config = parseConfig([tempDir(), 'Build the thing', '--yes']);
    config.preferencesPath = path.join(tempDir(), '.custom-prefs.json');
    const savePreferences = vi.fn();

    commitSetupSelections(config, {
      selections: {
        authorAgentId: 'copilot',
        authorModel: 'my-custom-author-model',
        reviewerAgentId: 'codex',
        reviewerModel: 'my-custom-reviewer-model',
        save: true,
      },
    }, { savePreferences });

    expect(config.authorSettings.model).toBe('my-custom-author-model');
    expect(config.reviewerSettings.model).toBe('my-custom-reviewer-model');
    expect(savePreferences).toHaveBeenCalledWith({
      author: { agent: 'copilot', model: 'my-custom-author-model' },
      reviewer: { agent: 'codex', model: 'my-custom-reviewer-model' },
    }, {
      filePath: config.preferencesPath,
    });
  });

  it('parses editor commands without stripping Windows path backslashes', () => {
    expect(parseEditorCommand('code --wait')).toEqual({ command: 'code', args: ['--wait'] });
    expect(parseEditorCommand('"C:\\Program Files\\Editor\\editor.exe" --wait', { platform: 'win32' })).toEqual({
      command: 'C:\\Program Files\\Editor\\editor.exe',
      args: ['--wait'],
    });
    expect(parseEditorCommand(String.raw`vim\ -f file`, { platform: 'linux' })).toEqual({
      command: 'vim -f',
      args: ['file'],
    });
  });
});
