import { isAbsolute, relative, resolve } from 'node:path';
import {
  PermissionDecision,
  createAcpRuntime,
  createRuntimeInspector,
} from '@acp-kit/core';
import { createLocalFileSystemHost, createLocalTerminalHost, nodeChildProcessTransport } from '@acp-kit/core/node';
import { formatEnvAssignment } from '../config/shell.mjs';
import { createStartupProfiler, roleStatusMessageForPhase } from './startup-profile.mjs';

export async function openRole({ role, settings, cwd, trace, captureTrace, renderer }) {
  let lastRoleStatusMessage = null;
  const emitRoleStatus = (message) => {
    if (!message || message === lastRoleStatusMessage) return;
    lastRoleStatusMessage = message;
    renderer.onRoleStatus?.({ role, message });
  };
  const startupProfile = createStartupProfiler({
    scope: 'role-startup',
    role,
    agent: settings.agent,
    onEvent: (event) => {
      const message = roleStatusMessageForPhase(event);
      emitRoleStatus(message);
    },
  });
  startupProfile.mark({
    phase: role === 'AUTHOR' ? 'author role open begin' : 'reviewer role open begin',
    detail: { cwd },
  });
  const inspector = createRuntimeInspector({ includeWire: Boolean(trace || captureTrace) });
  const unsubscribeTrace = renderer.onTraceEntry
    ? inspector.onEntry((entry) => {
      renderer.onTraceEntry?.({ role, entry });
    })
    : () => {};
  const fsHost = createLocalFileSystemHost({ root: cwd });
  const terminalHost = createLocalTerminalHost({
    resolveCwd: (requestedCwd) => resolveTerminalCwd(cwd, requestedCwd),
  });
  emitRoleStatus('launching...');

  const runtime = createAcpRuntime({
    agent: settings.agent,
    inspector,
    transport: nodeChildProcessTransport({
      useLoginShell: process.platform !== 'win32',
    }),
    host: {
      ...fsHost,
      ...terminalHost,
      // This demo is intentionally unattended after the initial CLI confirmation.
      requestPermission: async () => PermissionDecision.AllowAlways,
      chooseAuthMethod: async ({ methods }) => methods[0]?.id ?? null,
    },
    startupObserver: startupProfile,
  });

  let session;
  let unsubscribeUsage = () => {};
  let unsubscribePlan = () => {};
  try {
    session = await runtime.newSession({ cwd: resolve(cwd) });
    if (renderer.onUsageUpdate) {
      unsubscribeUsage = session.on('session.usage.updated', (event) => {
        if (process.env.ACP_REVIEW_DEBUG_USAGE) {
          process.stderr.write(`[usage] ${role} ${JSON.stringify(event)}\n`);
        }
        const usage = readUsage(event);
        if (usage) renderer.onUsageUpdate({ role, usage });
      });
    }
    if (renderer.onPlanUpdate) {
      unsubscribePlan = session.on('session.plan.updated', (event) => {
        const entries = Array.isArray(event?.entries) ? event.entries : [];
        renderer.onPlanUpdate({ role, entries });
      });
    }
    if (settings.model) {
      emitRoleStatus(`session ready, setting model ${settings.model}...`);
      await setRequiredModel({ role, session, settings });
    } else {
      emitRoleStatus('session ready, leaving default model unchanged...');
    }
    startupProfile.mark({
      phase: 'role ready',
      detail: { model: settings.model ?? null },
    });
    emitRoleStatus('ready');
    return {
      role,
      inspector,
      session,
      startupProfile,
      close: async () => {
        unsubscribeUsage();
        unsubscribePlan();
        unsubscribeTrace();
        await cleanupRoleResources({ session, runtime, terminalHost });
      },
    };
  } catch (error) {
    unsubscribeUsage();
    unsubscribePlan();
    unsubscribeTrace();
    let cleanupError = null;
    try {
      await cleanupRoleResources({ session, runtime, terminalHost });
    } catch (errorDuringCleanup) {
      cleanupError = errorDuringCleanup;
    }
    if (trace) {
      console.error(inspector.toJSONL());
    }
    startupProfile.mark({
      phase: 'role startup failed',
      detail: { error: error instanceof Error ? error.message : String(error) },
    });
    if (cleanupError) {
      throw new AggregateError(
        [toError(error), ...toErrorList(cleanupError)],
        'Role startup failed and cleanup also failed.',
      );
    }
    throw error;
  }
}

function readUsage(value) {
  if (!value || typeof value !== 'object') return null;
  const usage = {
    used: readNumber(value, 'used', 'currentTokens', 'current_tokens'),
    size: readNumber(value, 'size', 'tokenLimit', 'token_limit'),
    cost: readOptionalNumber(value, 'cost'),
    inputTokens: readNumber(value, 'inputTokens', 'input_tokens'),
    outputTokens: readNumber(value, 'outputTokens', 'output_tokens'),
    totalTokens: readNumber(value, 'totalTokens', 'total_tokens'),
    cachedReadTokens: readNumber(value, 'cachedReadTokens', 'cached_read_tokens'),
    cachedWriteTokens: readNumber(value, 'cachedWriteTokens', 'cached_write_tokens'),
    thoughtTokens: readNumber(value, 'thoughtTokens', 'thought_tokens'),
  };
  return Object.values(usage).some((item) => Number.isFinite(item)) ? usage : null;
}

function readNumber(value, ...keys) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      const number = Number(value[key]);
      if (Number.isFinite(number)) return number;
    }
  }
  return undefined;
}

function readOptionalNumber(value, ...keys) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(value, key) && value[key] != null) {
      const number = Number(value[key]);
      if (Number.isFinite(number)) return number;
    }
  }
  return undefined;
}

function resolveTerminalCwd(root, requestedCwd) {
  const resolvedRoot = resolve(root);
  const resolvedCwd = !requestedCwd
    ? resolvedRoot
    : isAbsolute(requestedCwd)
      ? resolve(requestedCwd)
      : resolve(resolvedRoot, requestedCwd);

  const rel = relative(resolvedRoot, resolvedCwd);
  if (rel && (
    rel === '..'
    || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
    || isAbsolute(rel)
  )) {
    throw new Error(`Terminal cwd escapes workspace root: ${requestedCwd}`);
  }
  return resolvedCwd;
}

async function setRequiredModel({ role, session, settings }) {
  const models = getAvailableModels(session);
  if (models.length > 0 && !models.some((model) => model.id === settings.model)) {
    throw createConfigurationError(formatUnavailableModelError({ role, settings, models }));
  }

  try {
    await session.setModel(settings.model);
  } catch (error) {
    throw createConfigurationError(formatRejectedModelError({ role, settings, models, error }));
  }
}

function createConfigurationError(message) {
  const error = new Error(message);
  error.name = 'ConfigurationError';
  return error;
}

function getAvailableModels(session) {
  const available = session.transcript?.session?.models?.availableModels;
  if (!Array.isArray(available)) return [];
  return available
    .map((model) => ({
      id: model.modelId || model.id,
      name: model.name,
    }))
    .filter((model) => typeof model.id === 'string' && model.id.length > 0);
}

function formatUnavailableModelError({ role, settings, models }) {
  const example = formatEnvAssignment(settings.modelEnvName, models[0]?.id ?? '<model-id>');
  const useDefault = formatEnvAssignment(settings.modelEnvName, '');
  return [
    `${settings.modelEnvName}="${settings.model}" is not available for ${settings.agent.displayName}.`,
    '',
    formatModelList(models),
    '',
    `Choose one of those models, for example:`,
    `  ${example}`,
    '',
    `Or use the agent default:`,
    `  ${useDefault}`,
    '',
    `${role} did not start because the configured model was rejected before the first turn.`,
  ].join('\n');
}

function formatRejectedModelError({ role, settings, models, error }) {
  const useDefault = formatEnvAssignment(settings.modelEnvName, '');
  const lines = [
    `${settings.modelEnvName}="${settings.model}" was rejected by ${settings.agent.displayName}.`,
    '',
  ];
  if (models.length > 0) {
    lines.push(formatModelList(models), '');
  } else {
    lines.push(
      'This agent did not report an available model list, so ACP Kit cannot suggest valid model ids.',
      '',
    );
  }
  lines.push(
    `Set ${settings.modelEnvName} to a supported model id, or use the agent default:`,
    `  ${useDefault}`,
    '',
    `${role} did not start because the configured model could not be applied.`,
    '',
    `Caused by: ${error instanceof Error ? error.message : String(error)}`,
  );
  return lines.join('\n');
}

function formatModelList(models) {
  return [
    'Available models:',
    ...models.map((model) => `  - ${model.id}${model.name && model.name !== model.id ? ` (${model.name})` : ''}`),
  ].join('\n');
}

async function cleanupRoleResources({ session, runtime, terminalHost }) {
  const errors = [];

  if (session) {
    const closeSession = typeof session.close === 'function'
      ? session.close.bind(session)
      : session.dispose?.bind(session);
    await closeSession?.().catch((error) => {
      errors.push(error);
    });
  }

  await runtime.shutdown().catch((error) => {
    errors.push(error);
  });

  try {
    killRemainingTerminals(terminalHost);
  } catch (error) {
    errors.push(error);
  }

  if (errors.length > 0) {
    throw new AggregateError(errors, 'Failed to clean up ACP role resources.');
  }
}

function killRemainingTerminals(terminalHost) {
  for (const child of terminalHost.terminals?.values?.() ?? []) {
    if (!child.killed && typeof child.kill === 'function') child.kill('SIGKILL');
  }
}

function toErrorList(error) {
  if (error instanceof AggregateError && Array.isArray(error.errors)) {
    return error.errors.map((item) => toError(item));
  }
  return [toError(error)];
}

function toError(error) {
  return error instanceof Error ? error : new Error(String(error));
}

export async function closeRole(state) {
  if (!state) return;
  await state.close();
}
