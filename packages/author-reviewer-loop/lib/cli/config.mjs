import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { agents, defaults } from '../config/agents.mjs';
import { readPreferences, normalizePreferences, preferencesFilePath as defaultPreferencesFilePath } from '../config/preferences.mjs';
import { env, envFlag, envPositiveInt, envStrictPositiveInt } from './env.mjs';

const packageJsonPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../package.json');

export function parseRunConfig({ argv, preferences, preferencesPath } = {}) {
  let parsedArgs;
  const program = new Command()
    .name('spar')
    .description('Run split-context AUTHOR and REVIEWER ACP agents over one workspace.')
    .usage('<cwd> <task-or-task-file...> [--yes] [--cli] [--quality prod|dev]')
    .argument('<cwd>', 'workspace directory')
    .argument('<task...>', 'task text, or a relative/absolute path to a UTF-8 task file')
    .option('-y, --yes', 'skip confirmation prompt')
    .option('--cli', 'use the plain line-based renderer instead of the default TUI')
    .option('--tui', 'use the Ink TUI renderer (default; kept for compatibility)')
    .option('--quality <quality>', 'quality level: prod|dev')
    .version(readPackageVersion(), '-v, --version', 'output the current version')
    .addHelpText('after', `
Environment:
  AUTHOR_AGENT=copilot|claude|codex|gemini|qwen|opencode   TUI: no built-in default; CLI default: ${defaults.authorAgent}
  AUTHOR_MODEL=<model-id>                                  TUI: chosen per agent; CLI default: ${defaults.authorModel}
  REVIEWER_AGENT=copilot|claude|codex|gemini|qwen|opencode TUI: no built-in default; CLI default: ${defaults.reviewerAgent}
  REVIEWER_MODEL=<model-id>                                TUI: chosen per agent; CLI default: ${defaults.reviewerModel}
  SPAR_QUALITY=prod|dev                                     default: prod
  MAX_ROUNDS=<n>                                            default: ${defaults.maxRounds}
  AUTHOR_SESSION_TURNS=<n>                                  default: ${defaults.sessionTurns}
  REVIEWER_SESSION_TURNS=<n>                                default: ${defaults.sessionTurns}
  Saved config: ${defaultPreferencesFilePath()}
  ACP_REVIEW_YES=1                                          skip confirmation prompt
  ACP_REVIEW_CLI=1                                          use the plain line-based renderer
  ACP_REVIEW_TUI=1                                          use the Ink TUI renderer (default)
  ACP_REVIEW_TRACE=1                                        print inspector trace on startup failures
  ACP_REVIEW_EDITOR_TIMEOUT_MS=<ms>                         TUI task editor timeout (default: 1800000)
`)
    .action((cwdArg, taskParts) => {
      parsedArgs = { cwdArg, taskParts };
    });

  if (argv) program.parse(argv, { from: 'user' });
  else program.parse();

  const cwd = path.resolve(parsedArgs.cwdArg);
  const { task, taskSource } = resolveTask(parsedArgs.taskParts, cwd);
  const opts = program.opts();
  const tui = resolveRendererMode(opts);
  const quality = resolveQuality(opts);
  const resolvedPreferencesPath = preferencesPath ?? defaultPreferencesFilePath();
  const saved = normalizePreferences(preferences ?? readPreferences({ filePath: resolvedPreferencesPath }));
  const authorResolved = resolveRoleConfig({
    role: 'author',
    agentEnvName: 'AUTHOR_AGENT',
    modelEnvName: 'AUTHOR_MODEL',
    preferencesPath: resolvedPreferencesPath,
    saved,
    defaultAgent: defaults.authorAgent,
    defaultModel: defaults.authorModel,
    useBuiltInDefaults: !tui,
  });
  const reviewerResolved = resolveRoleConfig({
    role: 'reviewer',
    agentEnvName: 'REVIEWER_AGENT',
    modelEnvName: 'REVIEWER_MODEL',
    preferencesPath: resolvedPreferencesPath,
    saved,
    defaultAgent: defaults.reviewerAgent,
    defaultModel: defaults.reviewerModel,
    useBuiltInDefaults: !tui,
  });

  const config = {
    cwd,
    task,
    taskSource,
    maxRounds: envPositiveInt('MAX_ROUNDS', defaults.maxRounds),
    quality,
    trace: envFlag('ACP_REVIEW_TRACE'),
    skipConfirm: Boolean(opts.yes) || envFlag('ACP_REVIEW_YES'),
    tui,
    preferencesPath: resolvedPreferencesPath,
    authorSettings: {
      agent: authorResolved.agent,
      agentId: authorResolved.agentId,
      agentSource: authorResolved.agentSource,
      model: authorResolved.model,
      modelSource: authorResolved.modelSource,
      modelEnvName: 'AUTHOR_MODEL',
      sessionTurns: envStrictPositiveInt('AUTHOR_SESSION_TURNS', defaults.sessionTurns),
      prompt: ({ round, feedback }) => createAuthorPrompt({
        cwd,
        task: config.task,
        round,
        feedback,
        quality: config.quality,
      }),
    },
    reviewerSettings: {
      agent: reviewerResolved.agent,
      agentId: reviewerResolved.agentId,
      agentSource: reviewerResolved.agentSource,
      model: reviewerResolved.model,
      modelSource: reviewerResolved.modelSource,
      modelEnvName: 'REVIEWER_MODEL',
      sessionTurns: envStrictPositiveInt('REVIEWER_SESSION_TURNS', defaults.sessionTurns),
      prompt: ({ round, feedback, authorReply }) => createReviewerPrompt({
        cwd,
        task: config.task,
        round,
        feedback,
        authorReply,
        quality: config.quality,
      }),
    },
  };
  const wrapEnvConfigured = ('SPAR_WRAP_ENABLED' in process.env) || ('ACP_REVIEW_WRAP' in process.env);
  const wrapEnvEnabled = envFlag('SPAR_WRAP_ENABLED') || envFlag('ACP_REVIEW_WRAP');
  config.wrap = tui
    ? (wrapEnvConfigured ? wrapEnvEnabled : true)
    : wrapEnvEnabled;
  return config;
}

function readPackageVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function applyRoleSelection(config, { author, reviewer }) {
  applyOneRole(config.authorSettings, author);
  applyOneRole(config.reviewerSettings, reviewer);
}

function applyOneRole(settings, selection) {
  const agent = agents[selection?.agentId];
  if (!agent) {
    throw createConfigurationError(`Selected agent "${selection?.agentId}" is not supported.`);
  }
  settings.agent = agent;
  settings.agentId = selection.agentId;
  settings.agentSource = selection.agentSource ?? 'tui';
  settings.model = selection.model ?? null;
  settings.modelSource = selection.modelSource ?? 'tui';
}

function resolveRoleConfig({
  role,
  agentEnvName,
  modelEnvName,
  preferencesPath,
  saved,
  defaultAgent,
  defaultModel,
  useBuiltInDefaults,
}) {
  const savedRole = saved[role] ?? {};
  const agentValue = valueWithSource({
    envName: agentEnvName,
    savedValue: savedRole.agent,
    defaultValue: useBuiltInDefaults ? defaultAgent : undefined,
  });
  const modelValue = valueWithSource({
    envName: modelEnvName,
    savedValue: savedRole.model,
    defaultValue: useBuiltInDefaults ? defaultModel : undefined,
    emptyEnvValue: null,
  });
  const agentId = agentValue.value ? String(agentValue.value).toLowerCase() : undefined;
  if (agentId && !agents[agentId]) {
    throw createConfigurationError(
      `${agentValue.source === 'env' ? agentEnvName : `${role}.agent in ${preferencesPath}`}=${agentId} is not supported. Use one of: ${Object.keys(agents).join(', ')}.`,
    );
  }

  return {
    agent: agentId ? agents[agentId] : null,
    agentId,
    agentSource: agentValue.source,
    model: modelValue.value,
    modelSource: modelValue.source,
  };
}

function valueWithSource({ envName, savedValue, defaultValue, emptyEnvValue }) {
  if (envName in process.env) {
    const raw = process.env[envName]?.trim();
    return { value: raw || emptyEnvValue, source: 'env' };
  }
  if (savedValue !== undefined) return { value: savedValue, source: 'config' };
  if (defaultValue !== undefined) return { value: defaultValue, source: 'default' };
  return { value: undefined, source: 'unset' };
}

function previousFeedbackSection(feedback) {
  const text = typeof feedback === 'string' ? feedback.trim() : '';
  if (!text) return '';
  return `Previous reviewer feedback:\n${text}\n\n`;
}

function authorReplySection(authorReply) {
  const text = typeof authorReply === 'string' ? authorReply.trim() : '';
  if (!text) return '';
  return `AUTHOR's reply for this round (their summary of what they changed):\n${text}\n\n`;
}

function createAuthorPrompt({ cwd, task, round, feedback, quality }) {
  const taskLabel = round === 1 ? 'Task' : 'Current task';
  const feedbackText = String(feedback || '').trim() || '<none>';
  if (quality === 'dev') {
    const roundSpecificSection = round === 1
      ? ''
      : `REVIEWER feedback:\n${feedbackText}\n\n`;

    return [
      `You are the AUTHOR. Working dir: ${cwd}`,
      '',
      `${taskLabel}: ${task}`,
      '',
      roundSpecificSection ? roundSpecificSection.trimEnd() : null,
      round === 1
        ? 'Work on the task using your code agent tools.'
        : 'Continue the task using your code agent tools.',
      '',
      'Steps:',
      round === 1
        ? '1. Inspect the relevant project files and existing patterns.'
        : '1. Inspect the relevant files and reviewer feedback.',
      round === 1
        ? '2. Implement the changes needed to complete the task.'
        : '2. Apply the changes needed to address the feedback.',
      '3. Update tests or docs when they are part of the task or useful for validating the change.',
      '4. Run relevant validation when practical.',
      '5. Reply with a concise summary of what changed and what validation was run.',
    ].filter(Boolean).join('\n');
  }

  const roundSpecificSection = round === 1
    ? ''
    : `REVIEWER feedback:\n${feedbackText}\n\n`
      + 'Address every reviewer point in code, tests, docs, or behavior as needed. '
      + 'Keep the same production-grade bar from the first round; do not narrow the scope to only the quoted feedback.\n\n';

  return [
    `You are the AUTHOR. Working dir: ${cwd}`,
    '',
    `${taskLabel}: ${task}`,
    '',
    roundSpecificSection ? roundSpecificSection.trimEnd() : null,
    'Mission: deliver a production-grade result where passing tests means the user experience is ready for handoff with zero manual babysitting.',
    '',
    'Coverage requirements:',
    '1. Cover the relevant core logic and author-reviewer loop behavior with meaningful unit, integration, scenario/use-case, and realistic end-to-end tests when those layers are affected.',
    '2. Focus on boundary conditions, state transitions, recovery after interruption, long-context or multi-step flows, and interactions with external dependencies such as LLM adapters, filesystem, terminal, or persistence layers.',
    '',
    'Adversarial thinking before implementation:',
    '1. Think like a hostile tester first and identify 5-10 failure cases that could break the user experience.',
    '2. Include cases such as unpredictable or malformed LLM output, empty replies, contradictory reviewer guidance, logic loops, high latency, disk exhaustion, huge inputs, dependency conflicts, and interrupted recovery.',
    '3. Turn those failure cases into concrete assertions or regression coverage instead of aspirational notes.',
    '',
    'Guardrails:',
    '1. Do not write vanity tests that only inflate coverage, such as trivial getter/setter checks or mocks that ignore real failure modes.',
    '2. Use realistic fixtures, explicit assertions, and failure messages that explain what user-visible behavior regressed.',
    '3. If testing exposes a real bug, fix the root cause correctly instead of papering over it in the test.',
    '',
    'Execution steps:',
    '1. Create or update an adversarial scenario analysis report when the task warrants it.',
    '2. Implement the strongest relevant tests first or alongside the fix so each important case is measurable.',
    '3. Modify files on disk with your filesystem tools. Do not paste code.',
    '4. Keep changes focused, integrated with surrounding code, and validated with the existing project checks when practical.',
  ].filter(Boolean).join('\n');
}

function createReviewerPrompt({ cwd, task, round, feedback, authorReply, quality }) {
  const prompt = [
    `You are the REVIEWER. Round: ${round}`,
    '',
    `Original task: ${task}`,
    '',
    previousFeedbackSection(feedback).trimEnd(),
    authorReplySection(authorReply).trimEnd(),
    quality === 'dev'
      ? `Inspect the relevant project state under ${cwd} using your filesystem tools.`
      : `Inspect the whole project under ${cwd} using your filesystem tools.`,
  ];

  if (quality === 'dev') {
    prompt.push(
      'Review whether the task is completed.',
      '',
      'Check:',
      '1. The requested behavior is implemented.',
      '2. The changes are coherent with the surrounding code.',
      '3. Relevant validation was run when practical.',
      '',
      'Reply APPROVED on its own line if the task is completed.',
      'Otherwise reply with a terse numbered list of concrete fixes needed.',
    );
    return prompt.filter(Boolean).join('\n');
  }

  prompt.push(
    'Review the current project state and relevant modifications as a whole, not only the files or summary mentioned by the AUTHOR.',
    'Judge whether the AUTHOR translated the quality bar into concrete execution: meaningful tests, adversarial coverage, realistic fixtures, and correct bug fixes wired into the surrounding code.',
    'Expect coverage that reflects real user experience: relevant unit, integration, scenario/use-case, and realistic end-to-end checks where the task touches those layers.',
    'Reject vanity tests, over-idealized mocks, gaps in recovery behavior, and approval based only on happy paths or local file diffs.',
    'Do not assume nothing changed just because earlier rounds looked different.',
    'Reply APPROVED on its own line only if the project now fully solves the task, the tests are genuinely convincing, and no obvious bugs or omissions remain; otherwise reply with a terse numbered list of issues, each with concrete fix guidance when useful.',
    'Prefer actionable suggestions over questions; mention exact files, flows, or failure modes that still need work.',
  );
  return prompt.filter(Boolean).join('\n');
}

function resolveQuality(opts) {
  const raw = String(opts.quality ?? process.env.SPAR_QUALITY ?? 'prod').trim().toLowerCase();
  if (raw === 'prod' || raw === 'dev') return raw;
  throw createConfigurationError(`Invalid quality "${raw}". Use "prod" or "dev".`);
}

function resolveRendererMode(opts) {
  if (opts.cli) return false;
  if (opts.tui) return true;
  if (envFlag('ACP_REVIEW_TUI')) return true;
  if (envFlag('ACP_REVIEW_CLI')) return false;
  return true;
}

function resolveTask(taskParts, cwd) {
  const raw = taskParts.join(' ').trim();
  if (!raw) return { task: raw, taskSource: { kind: 'text' } };

  const candidate = path.isAbsolute(raw)
    ? path.resolve(raw)
    : path.resolve(cwd, raw);
  if (isReadableFile(candidate)) {
    return {
      task: fs.readFileSync(candidate, 'utf8'),
      taskSource: { kind: 'file', path: candidate },
    };
  }

  return { task: raw, taskSource: { kind: 'text' } };
}

function isReadableFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function createConfigurationError(message) {
  const error = new Error(message);
  error.name = 'ConfigurationError';
  return error;
}
