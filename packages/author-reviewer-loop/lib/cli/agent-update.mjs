import process from 'node:process';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const AGENT_UPDATE_TARGETS = {
  copilot: {
    label: 'GitHub Copilot',
    globalPackages: [],
    cachePackages: ['@github/copilot-language-server@latest'],
  },
  codex: {
    label: 'Codex',
    globalPackages: ['@openai/codex@latest'],
    cachePackages: ['@zed-industries/codex-acp@latest'],
  },
  claude: {
    label: 'Claude Code',
    globalPackages: ['@anthropic-ai/claude-code@latest'],
    cachePackages: ['@zed-industries/claude-code-acp@latest'],
  },
};

export function isAgentUpdateCommand(argv = []) {
  return argv[0] === 'update' && argv[1] === 'agents';
}

export function formatAgentUpdateHelp() {
  return `Usage: spar update agents [all|codex|claude|copilot]

Install or update supported code agent CLIs and cached ACP adapter packages.

Targets:
  all       update Copilot, Codex, Claude Code, and cached ACP packages (default)
  codex     global @openai/codex; cache @zed-industries/codex-acp
  claude    global @anthropic-ai/claude-code; cache @zed-industries/claude-code-acp
  copilot   cache @github/copilot-language-server
`;
}

export function resolveAgentUpdatePlan(target = 'all') {
  const normalized = String(target || 'all').trim().toLowerCase();
  if (normalized === 'all') {
    return mergePlans(Object.values(AGENT_UPDATE_TARGETS));
  }
  const selected = AGENT_UPDATE_TARGETS[normalized];
  if (!selected) {
    throw new Error(`Unknown agent update target "${target}". Use one of: all, codex, claude, copilot.`);
  }
  return mergePlans([selected]);
}

export function resolveAgentUpdatePackages(target = 'all') {
  const plan = resolveAgentUpdatePlan(target);
  return [...plan.globalPackages, ...plan.cachePackages];
}

function mergePlans(entries) {
  return {
    globalPackages: unique(entries.flatMap((entry) => entry.globalPackages ?? [])),
    cachePackages: unique(entries.flatMap((entry) => entry.cachePackages ?? [])),
  };
}

function unique(values) {
  return [...new Set(values)];
}

export function agentPackageCacheRoot() {
  return process.env.ACP_KIT_AGENT_CACHE_DIR
    || path.join(homedir(), '.acp-kit', 'agent-bin-cache');
}

export function agentPackageCacheDir(packageSpec, cacheRoot = agentPackageCacheRoot()) {
  const safeName = String(packageSpec || 'package').replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'package';
  return path.join(cacheRoot, safeName);
}

export async function runNpmInstallCachedPackages({ packages, cacheRoot = agentPackageCacheRoot(), spawnImpl = spawn, stdio = 'inherit' } = {}) {
  for (const packageSpec of packages ?? []) {
    const cacheDir = agentPackageCacheDir(packageSpec, cacheRoot);
    try {
      mkdirSync(cacheDir, { recursive: true });
    } catch (error) {
      return { ok: false, code: null, error, packageSpec, cacheDir };
    }
    const result = await runNpmInstallWithArgs({
      args: ['install', '--prefix', cacheDir, '--no-audit', '--no-fund', packageSpec],
      spawnImpl,
      stdio,
    });
    if (!result.ok) return { ...result, packageSpec, cacheDir };
  }
  return { ok: true, code: 0 };
}

function runNpmInstallWithArgs({ args, spawnImpl = spawn, stdio = 'inherit' } = {}) {
  return new Promise((resolve) => {
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    let child;
    try {
      child = spawnImpl(npmCmd, args, { stdio });
    } catch (error) {
      resolve({ ok: false, code: null, error });
      return;
    }
    child.on('error', (error) => resolve({ ok: false, code: null, error }));
    child.on('close', (code) => resolve({ ok: code === 0, code }));
  });
}

export async function runAgentUpdateCommand({
  argv = [],
  installGlobalImpl = runNpmInstallPackages,
  installCacheImpl = runNpmInstallCachedPackages,
  log = (msg) => process.stdout.write(`${msg}\n`),
} = {}) {
  if (!isAgentUpdateCommand(argv)) return null;
  const target = argv[2] && !argv[2].startsWith('-') ? argv[2] : 'all';
  if (argv.includes('-h') || argv.includes('--help')) {
    log(formatAgentUpdateHelp().trimEnd());
    return 0;
  }
  let plan;
  try {
    plan = resolveAgentUpdatePlan(target);
  } catch (error) {
    log(`Error: ${error instanceof Error ? error.message : String(error)}`);
    log('');
    log(formatAgentUpdateHelp().trimEnd());
    return 1;
  }
  if (plan.globalPackages.length > 0) {
    log(`Running: npm install -g ${plan.globalPackages.join(' ')}`);
    const result = await installGlobalImpl({ packages: plan.globalPackages });
    if (!result?.ok) {
      log('Global agent update failed. Check npm output above and retry.');
      return typeof result?.code === 'number' ? result.code || 1 : 1;
    }
  }
  if (plan.cachePackages.length > 0) {
    const cacheRoot = agentPackageCacheRoot();
    log(`Refreshing ACP package cache: ${cacheRoot}`);
    log(`Running cached installs for: ${plan.cachePackages.join(' ')}`);
    const result = await installCacheImpl({ packages: plan.cachePackages, cacheRoot });
    if (!result?.ok) {
      log('Cached ACP package update failed. Check npm output above and retry.');
      if (result?.cacheDir) log(`Cache directory: ${result.cacheDir}`);
      return typeof result?.code === 'number' ? result.code || 1 : 1;
    }
  }
  if (plan.globalPackages.length === 0 && plan.cachePackages.length === 0) {
    log('No agent packages selected.');
  } else {
    log('Agent update complete. Re-run `spar --doctor` to verify local availability.');
  }
  return 0;
}

export function runNpmInstallPackages({ packages, spawnImpl = spawn, stdio = 'inherit' } = {}) {
  if (!Array.isArray(packages) || packages.length === 0) {
    return Promise.resolve({ ok: true, code: 0 });
  }
  return runNpmInstallWithArgs({ args: ['install', '-g', ...packages], spawnImpl, stdio });
}
