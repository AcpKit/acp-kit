# Changelog

All notable changes to ACP Kit packages are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While ACP Kit is in `0.x`, **minor versions may include breaking changes** (per the SemVer 0.x convention). Patch versions remain backward compatible.

## [Unreleased]

## [0.9.0] - 2026-05-04

### Added
- `@acp-kit/core` now exposes reusable helpers for ACP session recovery, real-workspace agent policies, and session turn-budget rotation so long-running ACP applications can share the same recovery and workspace-safety behavior used by Spar.

## [0.8.1] - 2026-05-03

### Changed
- Repository release version advanced to `0.8.1` for the matching `@acp-kit/spar` patch release. Core package behavior is unchanged in this release; Spar-specific notes are documented in `packages/author-reviewer-loop/CHANGELOG.md`.

## [0.8.0] - 2026-05-02

### Changed
- Repository release version advanced to `0.8.0` for the matching `@acp-kit/spar` minor release. Core package behavior is unchanged in this release; Spar-specific notes are documented in `packages/author-reviewer-loop/CHANGELOG.md`.

## [0.6.16] - 2026-05-02

### Fixed
- `@acp-kit/core` now classifies turn cancellation only when the client requested cancellation or the ACP adapter returns the JSON-RPC cancellation code, avoiding false `turn.cancelled` events from unrelated error text.

## [0.6.14] - 2026-04-30

### Fixed
- `@acp-kit/core` local filesystem reads now return fresh on-disk content after edits instead of serving stale file text.

## [0.6.13] - 2026-04-30

### Added
- `@acp-kit/core` now prepares package-based ACP fallback adapters into a persistent user cache before spawning them, so missing local wrappers such as `claude-code-acp` and `codex-acp` do not require repeated cold `npx --yes ...@latest` launches. Startup profiling now records fallback package preparation and first adapter stdout/stderr timing.

### Fixed
- `@acp-kit/core` command lookup is cached across process starts and handles Windows npm/nvm shims more reliably, including PowerShell `.ps1` launchers.
- `@acp-kit/core` startup diagnostics now retain stdout, launch source, resolved command, lookup duration, npx fallback usage, and first output timing for easier adapter startup debugging.

## [0.6.11] - 2026-04-29

### Added
- `@acp-kit/core` now emits ACP `plan`, `reasoning`, tool `locations`, and tool structured `content` through the normalized event stream and transcript reducer. New runtime event `session.plan.updated` carries the latest `Plan` for a session; `tool.start` / `tool.update` / `tool.end` now carry `locations` and `content`. The transcript records `currentPlan` per session and `content` per tool record.

## [0.6.8] - 2026-04-29

### Changed
- `release-prep` skill rewritten to drop dedicated `Release X.Y.Z` commits: releases now ride on top of normal development commits and are marked solely by the tag.

### Fixed
- `@acp-kit/core` `collectTurnResult` now folds the session transcript's session usage into the final result and no longer lets a follow-up usage update with a zero `used` overwrite a positive prior value when `size` is unchanged.
- `@acp-kit/core` `normalizeAcpUpdate` accepts ACP `usage_update` payloads that report `currentTokens` / `tokenLimit` (and snake_case variants) in addition to `used` / `size`.
- `@acp-kit/core` `resolveCommandOnPath` resolves Windows PowerShell `.ps1` shims even when `PATHEXT` omits `.PS1`, fixing agent detection for installs that ship PowerShell launchers.

## [0.6.7] - 2026-04-28

### Fixed
- `@acp-kit/core` `normalizeAcpUpdate` now accepts ACP `usage_update` payloads that report `currentTokens` / `tokenLimit` (and snake_case variants) in addition to `used` / `size`, so context-window data from agents that use the alternate field names is no longer dropped.
- `@acp-kit/core` `collectTurnResult` now folds the session transcript's session usage into the final result and no longer lets a follow-up usage update with a zero `used` overwrite a positive prior value when `size` is unchanged.

### Added
- A local `release-prep` skill under `.github/skills/release-prep/SKILL.md` documenting the end-to-end release workflow used for ACP Kit.

## [0.6.6] - 2026-04-28

### Changed
- Rebuilt the recent changelog history so the `0.6.1` through `0.6.5` entries reflect the actual package, runtime, renderer, documentation, and test changes shipped in those releases.

## [0.6.5] - 2026-04-28

### Fixed
- `@acp-kit/core` command detection now handles Windows path extensions and command lookup edge cases more reliably.
- `@acp-kit/core` normalized events and turn-result collection cover additional edge cases for missing text, usage updates, and terminal tool metadata.

### Changed
- `@acp-kit/core` docs and runtime examples were refreshed for the renamed AcpKit organization and the current agent matrix.

## [0.6.4] - 2026-04-27

### Added
- `detectInstalledAgents(...)` and `isCommandOnPath(...)` in `@acp-kit/core` for fast, side-effect-free agent availability checks.

### Fixed
- `@acp-kit/core` Node transport now reuses the shared command detection helper instead of duplicating lookup logic.

## [0.6.3] - 2026-04-27

### Added
- Built-in agent profiles now launch local agent binaries first and fall back to their `npx ...@latest` commands when the binary is not on `PATH`.
- `@acp-kit/core` added broad edge-case test coverage for agent profile fallback, startup diagnostics, runtime inspection, recordings, normalization, sessions, transcripts, and turn-result collection.

### Fixed
- Node child-process transport now handles spawn errors such as `ENOENT` without crashing the host process and records the failure in startup diagnostics.
- Runtime inspector and diagnostic capture now handle large or unusual wire frames more robustly.

### Changed
- Agent docs and compatibility issue templates now document the fast local command names while noting the automatic `npx` fallback behavior.

## [0.6.2] - 2026-04-27

### Added
- `collectTurnResult(session, prompt, options)` in `@acp-kit/core`, a turn-level helper that collects streaming session events into one result object while still exposing live `onEvent` and `onUpdate` callbacks for UIs.

## [0.6.0] - 2026-04-26

### Added
- `createAcpRuntime({ agent })` now works without a `host`. The runtime defaults to approving tool permissions once and selecting the first offered auth method; pass an explicit host for production policy, UI prompts, file system/terminal capabilities, logging, or wire middleware.
- `PermissionDecision` constants (`AllowOnce`, `AllowAlways`, `Deny`) for host permission decisions, while keeping the existing string literals backward compatible.
- Enterprise runtime hooks: `observability.sink`, durable `eventStore.append/load`, external `approvals`, runtime correlation `context`, and replay helpers (`createRuntimeReplay`, `loadRuntimeReplay`, `replayRuntimeEvents`, `buildTranscriptFromRuntimeEvents`).
- Startup diagnostics via `AcpStartupError`, `isAcpStartupError(...)`, and `formatStartupDiagnostics(...)`.
- Runtime inspection via `createRuntimeInspector(...)` with optional redacted wire-frame capture.
- Session recording via `createMemorySessionRecorder(...)`, `loadSessionRecording(...)`, and Node JSONL helpers (`createFileSessionRecorder(...)`, `loadFileSessionRecording(...)`).

### Fixed
- Corrected permission-decision docs to use the actual supported deny value (`'deny'`) instead of non-existent `deny_once` / `deny_always` variants.
- Improved npm package metadata and README wording so searches for Agent Client Protocol framework/runtime terms can discover the package more reliably.

## [0.5.0] - 2026-04-22

Minor release with **breaking API changes** (allowed by 0.x SemVer). Renames the agent-selection surface so that what you pass to the runtime reads as "which agent", not "which configuration preset". Also expands the set of agents that ship as built-in named constants from 3 to 6.

### Breaking
- `RuntimeOptions.profile` is now `RuntimeOptions.agent`. Same for `RunOneShotPromptOptions.profile` (`runOneShotPrompt`), `AcpTransport.connect({ profile })`, and `AcpConnectionFactory.create({ profile })`. The field type is now strictly `AgentProfile` &mdash; **string ids are no longer accepted**; import the named constant instead.
- `RuntimeSession.profile` is now `RuntimeSession.agent` (read-only).
- Removed: `BuiltInProfileId`, `builtInProfiles`, `resolveAgentProfile`. Code that did `profile: 'claude'` should switch to `agent: ClaudeCode` (`import { ClaudeCode } from '@acp-kit/core'`).
- The startup-error message format changed from `... failed for profile "X".` to `... failed for agent "X".`.

### Added
- Six built-in agent constants exported from `@acp-kit/core`, all typed as `AgentProfile`:
  - `GitHubCopilot` &mdash; `npx @github/copilot-language-server@latest --acp`
  - `ClaudeCode` &mdash; `npx @zed-industries/claude-code-acp@latest`
  - `CodexCli` &mdash; `npx @zed-industries/codex-acp@latest`
  - `GeminiCli` &mdash; `npx @google/gemini-cli@latest --experimental-acp`
  - `QwenCode` &mdash; `npx @qwen-code/qwen-code@latest --acp --experimental-skills`
  - `OpenCode` &mdash; `npx opencode-ai@latest acp`

  Override individual fields with a spread: `{ ...ClaudeCode, env: { ANTHROPIC_API_KEY: '...' } }`.

### Why
The word "profile" suggested a configuration preset, but the value really answered "which agent". Accepting bare strings (`profile: 'claude'`) made typos a runtime failure and made it awkward to override a single field. Named constants give IDE autocompletion, compile-time safety, and a one-line spread for partial overrides &mdash; while still letting custom agents drop in via a plain `AgentProfile` literal.

### Migration
```ts
// Before (0.4.x):
import { createAcpRuntime } from '@acp-kit/core';
await using acp = createAcpRuntime({ profile: 'claude', host });

// After (0.5.0):
import { createAcpRuntime, ClaudeCode } from '@acp-kit/core';
await using acp = createAcpRuntime({ agent: ClaudeCode, host });

// Custom agent (was already supported, now passed under `agent`):
await using acp = createAcpRuntime({
  agent: { id: 'my-agent', displayName: 'My Agent', command: 'my-cli', args: ['--acp'] },
  host,
});
```

## [0.4.0] - 2026-04-22

Minor release. Aligns the runtime more closely with the upstream `agent-client-protocol` spec (currently v0.12.0, SDK ^0.18.0). No breaking changes for existing callers; only additive surface and one cosmetic correction.

### Added
- `RuntimeHost.promptCapabilities?: { image?, audio?, embeddedContext? }` &mdash; declared at construction; forwarded verbatim to the agent in `initialize.clientCapabilities.promptCapabilities`. Hosts that can render images, audio, or embedded resource references should opt in here so the agent is allowed to send those `ContentBlock` variants in `session/prompt` updates. Defaults to omitted (agent assumes text-only).
- `AcpRuntime.listSessions(params?)` &mdash; thin wrapper over ACP `session/list`. Throws if the agent does not advertise `agentCapabilities.sessionCapabilities.list`. Cursor-based pagination via the request's `cursor` and the response's `nextCursor`.
- `RuntimeSession.close()` &mdash; thin wrapper over ACP `session/close` (currently exposed by the SDK as `unstable_closeSession`). After the agent acknowledges, the session is also disposed locally. Falls back to `dispose()` when the agent does not advertise the capability, so it is safe to call unconditionally.
- `AcpTransportConnection` and `AcpConnectionLike` gain optional `listSessions?` and `unstable_closeSession?` slots for custom transports.

### Changed
- `initialize.clientInfo` now reports the actual installed package name and version (read from this package's own `package.json` at runtime) instead of the previously hardcoded `'@acp-kit/core' / '0.1.4'` placeholder. Bundlers that strip `node:fs` will fall back to `'@acp-kit/core' / '0.0.0'`.

### Removed
- Dropped three `sessionUpdate` cases from the notification normalizer that were never produced by the spec: `config_options_update` (plural duplicate of `config_option_update`), `modes_update`, and `models_update`. Mode state changes still flow through `current_mode_update` (unchanged), and the initial mode/model state advertised by `newSession` / `loadSession` continues to be replayed via `session.modes.updated` / `session.models.updated` events. No caller in the example apps was subscribed to the dropped variants; if a custom agent really did emit them, they were already being silently dropped at one layer and re-emitted as `session.unknown` &mdash; this just removes the dead branches.

### Why
A pass over the upstream spec (schema v0.12.0, CHANGELOG through v0.11.7) flagged: stale `clientInfo`, no opt-in for prompt content beyond text, and no surface for the now-stable `session/list` and the preview-stage `session/close`. This release closes those gaps without introducing any of the still-experimental surfaces (`elicitation/*`, `providers/*`, `session/fork`, `session/resume`); those will get evaluated once they stabilize.

### Migration
No changes required. Hosts that want to advertise richer prompt content should set `promptCapabilities` on the host object passed to `createAcpRuntime`.

## [0.3.1] - 2026-04-22

Patch release. Backwards compatible additions extracted from real daemon usage.

### Added
- `isAcpCancelled(error)` &mdash; returns `true` for JSON-RPC code `-32800` or messages matching `cancelled` / `canceled` / `aborted`. Use to distinguish "the agent cancelled this turn" from "the agent failed".
- `isAcpAuthRequired(error)` &mdash; returns `true` for JSON-RPC code `-32000` or messages requiring authentication. Same logic the runtime already uses internally for `withAuthRetry`, now exposed so callers can react identically (e.g. surface a "sign in" UI).
- `RuntimePermissionRequest.title: string` &mdash; the human-readable title surfaced by the agent for the operation needing approval (extracted from `toolCall.title` on the raw payload). Hosts no longer need to dig through `request.raw?.toolCall?.title` to render a prompt.

Both helpers re-exported from the main entry (`@acp-kit/core`); `RuntimePermissionRequest` is unchanged in shape, only adds an extra field.

## [0.3.0] - 2026-04-22

Minor release. No breaking changes &mdash; only new opt-in exports under `@acp-kit/core/node`.

### Added
- `createLocalFileSystemHost({ root, onAccess?, followSymlinksOutsideRoot? })` &mdash; reference implementation of ACP's `fs/read_text_file` and `fs/write_text_file` for hosts that serve a single local workspace root. Sandboxed by lexical resolution + `realpath` check; rejects `..` traversal and (by default) symlinks pointing outside `root`. Supports the `line` / `limit` slicing parameters and auto-creates parent directories on write.
- `createLocalTerminalHost({ resolveCwd?, env?, defaultOutputByteLimit? })` &mdash; reference implementation of ACP's terminal capability via `node:child_process.spawn`. Bounded ring buffer for output, exit code + signal capture, optional `waitForTerminalExit` timeout. `releaseTerminal` releases host bookkeeping but does **not** kill the underlying process (matches ACP spec semantics; previous in-house copies in user codebases often killed on release &mdash; review your call sites if you migrate).
- Both helpers exported from `@acp-kit/core/node` (they pull in `node:fs` / `node:child_process`, so they stay off the main entry).

### Why
The `RuntimeHost` interface is intentionally minimal &mdash; permission policy, UI bridging, and audit logging belong in the host. But the local-disk implementation of fs and terminal capabilities is roughly the same in every daemon-shaped host, and writing it from scratch per project (with subtle path-escape and output-bounding bugs) is exactly the boilerplate ACP Kit exists to delete. These are explicit `import`s, not defaults &mdash; hosts that need their own implementation (VS Code's terminal API, remote agents, container sandboxes) ignore them.

### Migration
Existing hosts continue to work unchanged. To opt in:

```ts
import { createAcpRuntime } from '@acp-kit/core';
import { createLocalFileSystemHost, createLocalTerminalHost } from '@acp-kit/core/node';

const fsHost = createLocalFileSystemHost({ root: workingDirectory });
const termHost = createLocalTerminalHost({ resolveCwd: (cwd) => resolveSessionPath(workingDirectory, cwd) });

const runtime = createAcpRuntime({
  profile,
  host: { ...fsHost, ...termHost, requestPermission, onAgentExit },
});
```

## [0.2.2] - 2026-04-22

Patch release. Non-breaking.

### Added
- `RuntimeSession.transcript` &mdash; read-only public getter returning the session's reducer state (messages, reasoning, tool calls, mode / model state, open stream ids, usage). Useful for reading the initial mode / model state populated by `newSession` / `loadSession` before the first handler has a chance to attach, and for rendering UI snapshots mid-stream without resubscribing. Previously only accessible via `getSnapshot()`, which returned a deep clone on each call.

## [0.2.1] - 2026-04-22

Patch release. Non-breaking additions to the normalized event surface so every ACP session update has a typed runtime event and vendor extensions survive the normalization layer.

### Added
- `ToolStartEvent` / `ToolUpdateEvent` / `ToolEndEvent` now carry an optional `meta?: Record<string, unknown>` field, forwarding the raw `_meta` object from the underlying ACP update verbatim. ACP's `_meta` is the spec-defined vendor-extension slot &mdash; consumers that want vendor-specific tool names, arguments, or responses (e.g. `_meta.claudeCode.toolName`) no longer have to attach a wire middleware to reach them.
- New `SessionErrorEvent` (`type: 'session.error'`) mapping ACP's `session_error` session-update variant. `RuntimeEventHandlers.sessionError?: (e) => void` is now part of the handler-map dispatch (`session.on({ sessionError: ... })`), and `RuntimeEventKind.SessionError` is exported.

### Compatibility
Both additions are non-breaking: existing code that did not read `meta` or handle `session.error` continues to work unchanged.

## [0.2.0] - 2026-04-21

Minor release with **breaking changes** (allowed in 0.x). The dual normalized / raw event surface is collapsed into a single normalized track, and the helper is reshaped into an idiomatic handler-map dispatch.

### Changed (breaking)
- **Removed the raw session-update track.** `session.onRawNotification`, `session.events()`, `onRawSessionUpdate`, `SessionUpdateKind`, and `packages/core/src/session-update.ts` are gone. All consumers now go through the normalized `RuntimeSessionEvent` stream (`message.delta`, `tool.start` / `tool.update` / `tool.end`, `turn.completed`, ...). For unfiltered raw access, attach a wire middleware via `createAcpRuntime({ wireMiddleware })`.
- **`session.prompt(text)` returns `Promise<PromptResult>` only.** It no longer doubles as an `AsyncIterable` of `PromptHandle` notifications. Subscribe to events via `session.on(...)` *before* calling `prompt(...)`.
- **Added `session.on(handlers)` overload** that takes a camelCase handler map (`{ messageDelta, toolStart, toolEnd, turnCompleted, ... }`) covering every `RuntimeSessionEvent`. The single-event-type and `'event'` overloads remain.
- **`runOneShotPrompt(...)` now yields normalized `RuntimeSessionEvent`s** instead of raw `PromptHandle` notifications. Same name, same one-shot lifecycle, new payload type.
- **Fixed prototype-strip bug in `transports/node.ts`.** The default node transport was spreading the underlying `ClientSideConnection` into a new object, which silently dropped class-prototype methods like `initialize` and `prompt`. The transport now mutates `dispose` in place to keep the original instance intact.

### Examples
- Removed `examples/advanced-multi-session/` (superseded by `pair-programming/`, which is a stronger multi-session demo).
- `examples/quick-start/` and all docs migrated to `runOneShotPrompt` + `session.on({ ... })` handler-map style.

## [0.1.4] - 2026-04-23

Patch release. Naming-only change: the one-shot helper is renamed to better describe what it does.

### Changed (breaking)
- `runAcpAgent(...)` and the `RunAcpAgentOptions` interface are renamed to **`runOneShotPrompt(...)`** / **`RunOneShotPromptOptions`**. The shape, behavior, and return type are unchanged. The old name returned an async iterable that spawned an agent, ran a single prompt, and disposed everything on completion — but "agent" referred to the *remote* process, not the helper itself, and "run" suggested a long-lived thing. The new name describes the actual lifecycle: **one prompt, then teardown**. Migration is a single find-and-replace.

## [0.1.3] - 2026-04-23

Patch release. No breaking changes — existing `createAcpRuntime` / `runAcpAgent` / `session.prompt(...)` code keeps working unchanged.

This release makes `AcpRuntime` actually behave the way the README promised: **one runtime owns one agent subprocess, and that subprocess hosts as many ACP sessions as you create**. Previously, every call to `acp.newSession(...)` spawned a fresh process and ran a full `initialize` handshake. Now `initialize` happens once on the first `newSession` / `loadSession` / `ready()` call, and every subsequent session reuses the same connection.

### Added
- `acp.loadSession({ sessionId, cwd?, mcpServers? })` — resume a previously created ACP session by id. Throws if the agent does not advertise the `loadSession` capability.
- `acp.ready()` — explicitly spawn the agent process and complete `initialize` without creating a session yet. Useful for warming up or for inspecting `agentInfo` / `authMethods` before deciding what to do.
- `acp.isReady` — boolean getter, `true` once the agent has been initialized.
- `acp.agentInfo`, `acp.authMethods`, `acp.agentCapabilities`, `acp.protocolVersion` — agent metadata returned by `initialize`. `null` / empty until the runtime has connected.
- `NewSessionOptions.mcpServers?: McpServer[]` and `LoadSessionOptions.mcpServers?: McpServer[]` — properly typed (was `unknown[]`). Forwarded to ACP `session/new` and `session/load` respectively.
- `AcpConnectionFactory.create(...).loadSession?(...)` — optional capability used by `acp.loadSession`.

### Changed (non-breaking)
- One agent subprocess per `AcpRuntime` (was: one per session). `acp.shutdown()` still tears everything down the same way; `session.dispose()` no longer closes the underlying process — the runtime owns its lifecycle.
- The `auth_required` retry path is now a shared internal helper used by both `newSession` and `loadSession`.
- ACP `session/update` notifications are now routed to the matching session via the notification's own `sessionId`, instead of being assumed to belong to a single session.

### Tests
- Added coverage for: shared-process behavior across multiple sessions, `agentInfo` / `authMethods` / `agentCapabilities` exposure, `session/update` routing across two concurrent sessions, `loadSession` happy path, and the `loadSession` capability check.

## [0.1.2] - 2026-04-22

This release reshapes the public API around two ergonomic entry points and aligns the streaming surface with raw ACP. `createRuntime` from 0.1.x stays exported as an alias for `createAcpRuntime`; everything else listed under "breaking" below is a hard change.

### Added
- `createAcpRuntime(options)` — primary entry point. Returns an `AcpRuntime` that owns one agent subprocess and can host multiple sessions.
- `runAcpAgent({ profile, cwd, prompt, host?, ... })` — one-shot helper that returns `AsyncIterable<SessionNotification>` and tears down the runtime when iteration ends. *(Renamed to `runOneShotPrompt` in 0.1.4.)*
- `Symbol.asyncDispose` on both `AcpRuntime` and `RuntimeSession`. Use `await using acp = createAcpRuntime(...)` and `await using session = await acp.newSession({ cwd })` to get automatic cleanup. Requires Node ≥ 20.11 (or TypeScript 5.2+ down-leveling).
- `acp.shutdown()` — explicit, idempotent runtime teardown when `await using` is not available.
- `session.prompt(text)` now returns a `PromptHandle` that is **both** a `Promise<PromptResult>` **and** an `AsyncIterable<SessionNotification>` for the turn. Iterate it to consume raw ACP notifications, or `await` it for the final result.
- `session.events()` — `AsyncIterable<SessionNotification>` for the lifetime of the session.
- `session.onRawNotification(fn)` — listener form of the raw stream.
- `examples/advanced-multi-session/` — demonstrates one runtime hosting two `await using` sessions over different `cwd`s.

### Changed (breaking)
- `RuntimeOptions.cwd` removed. Pass `cwd` per session via `acp.newSession({ cwd })`.
- `createRuntime` is now a thin alias for `createAcpRuntime`. New code should prefer `createAcpRuntime`.
- `session.prompt(text)` previously returned `Promise<PromptResult>`. It now returns a `PromptHandle`. Existing `await session.prompt(...)` code keeps working unchanged.
- `examples/quick-start/` rewritten around `runAcpAgent`. `examples/real-agent-cli/` and `examples/mock-runtime/` migrated to `createAcpRuntime` + per-session `cwd`.

### Docs
- README, package README, and the doc site (`docs/`) rewritten around the dual-track API and the real ACP `session/update` discriminators (`agent_message_chunk`, `tool_call`, `tool_call_update`, `plan`, `agent_thought_chunk`, ...).

## [0.1.1] - 2026-04-21

### Added
- `author: "ACP Kit contributors"` in `packages/core/package.json` so the npm page no longer shows a personal username as the package author.
- Restructured `examples/` into three focused, self-contained scenarios:
  - [`examples/quick-start/`](examples/quick-start/) — minimal runnable mirror of the README Quick Start.
  - [`examples/mock-runtime/`](examples/mock-runtime/) — fully self-contained mock ACP server, runs without any agent installed (`npm run demo`).
  - [`examples/real-agent-cli/`](examples/real-agent-cli/) — interactive CLI driver against real ACP agents (`npm run demo:real`).
- New root scripts: `demo:quick-start`, `demo:real`.
- `examples/README.md` index.

### Removed
- `examples/runtime-demo.mjs` (replaced by the three focused examples above).

## [0.1.0] - 2026-04-21

Initial public release.

### Added
- `@acp-kit/core` package: a single-package runtime built on `@agentclientprotocol/sdk`.
- `createRuntime({ profile, cwd, host })` entry point.
- Built-in agent profiles for Copilot CLI, Claude ACP, and Codex ACP.
- Cross-platform process spawn with startup timeout, stderr capture, and exit diagnostics.
- ACP connection bootstrap: `initialize`, `session/new`, `session/prompt`, `session/cancel`.
- Auth retry when `session/new` returns `auth_required`, via host `chooseAuthMethod` callback.
- Host adapters: `requestPermission`, `chooseAuthMethod`, `readTextFile`, `writeTextFile`, `createTerminal`, `log`.
- Normalized runtime events for messages, reasoning, tools, usage, mode/model updates.
- Transcript reducer with pending stream completion flushing for clean turn finalization.
- Mock + real-agent runnable demo at `examples/runtime-demo.mjs`.

[0.1.2]: https://github.com/AcpKit/acp-kit/releases/tag/v0.1.2
[0.1.1]: https://github.com/AcpKit/acp-kit/releases/tag/v0.1.1
[0.1.0]: https://github.com/AcpKit/acp-kit/releases/tag/v0.1.0
