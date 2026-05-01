# Changelog

All notable changes to ACP Kit packages are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While ACP Kit is in `0.x`, **minor versions may include breaking changes** (per the SemVer 0.x convention). Patch versions remain backward compatible.

## [Unreleased]

## [0.7.0] - 2026-05-02

### Added

- `@acp-kit/author-reviewer-loop` / `@acp-kit/spar` adds `--quality prod|dev` and `SPAR_QUALITY`, keeping the existing production-grade adversarial prompt as `prod` while offering a lighter `dev` prompt that follows the default code-agent workflow.
- `@acp-kit/author-reviewer-loop` / `@acp-kit/spar` now records one Spar session lifecycle per invocation, persists run recovery checkpoints separately, and resumes interrupted author/reviewer/approval steps when the saved ACP role sessions are still available.
- `@acp-kit/author-reviewer-loop` / `@acp-kit/spar` adds deterministic process-level E2E coverage for Codex launch behavior, proving the real CLI starts `codex-acp` with real-workspace defaults and that the reviewer sees author disk writes.

### Changed

- `@acp-kit/author-reviewer-loop` / `@acp-kit/spar` launches Codex with `sandbox_mode="danger-full-access"` and `approval_policy="never"` so AUTHOR writes land in the real workspace shared with REVIEWER instead of a temporary sandbox write layer.
- `@acp-kit/author-reviewer-loop` / `@acp-kit/spar` renames local diagnostic traces from ambiguous session traces to run traces under `~/.acp-kit/spar/run-traces`.

### Fixed

- `@acp-kit/author-reviewer-loop` / `@acp-kit/spar` preserves streamed word chunks by default when agents split text or reasoning deltas mid-word, while still respecting explicit whitespace and punctuation boundaries.

## [0.6.17] - 2026-05-02

### Fixed

- Spar fixes a TUI crash when opening trace, tool-call, task, or error detail screens with wrapping enabled. Detail row rendering no longer references React view state from an outer helper default parameter, and regression tests now cover the helper boundary, long-token wrapping, and tool-output size summaries.

## [0.6.16] - 2026-05-02

### Fixed

- `@acp-kit/core` now classifies turn cancellation only when the client requested cancellation or the ACP adapter returns the JSON-RPC cancellation code, avoiding false `turn.cancelled` events from unrelated error text.
- `@acp-kit/author-reviewer-loop` / `@acp-kit/spar` now closes ACP sessions gracefully before force-killing leftover terminal processes, reducing spurious tool-call interruption reports.
- `@acp-kit/author-reviewer-loop` / `@acp-kit/spar` fixes TUI/plain renderer regressions around split streaming words, wrapped long lines showing truncation dots, and tool-call summaries missing output line counts.

## [0.6.15] - 2026-04-30

### Changed

- `@acp-kit/core` and `@acp-kit/spar` now share release version `0.6.15`, with Spar depending on the matching core line.
- `@acp-kit/author-reviewer-loop` / `@acp-kit/spar` user files now live under `~/.acp-kit/spar`, including preferences, startup profiling, and update-check cache data, so ACP Kit uses one top-level home directory.
- `@acp-kit/author-reviewer-loop` / `@acp-kit/spar` startup profiling is enabled by default and writes to `~/.acp-kit/spar/startup-profile.log`; set `ACP_STARTUP_PROFILE=0` to disable it.
- `@acp-kit/author-reviewer-loop` / `@acp-kit/spar` keeps the always-visible TUI footer focused on primary controls while advanced controls remain available through help.

### Fixed

- `@acp-kit/author-reviewer-loop` / `@acp-kit/spar` fixes TUI regressions around setup/confirmation animation, trace state leaking into confirmation, boxing-glove truncation dots, model-title closing parentheses, and approval force-continue handling.
## [0.6.14] - 2026-04-30

### Changed

- `@acp-kit/author-reviewer-loop` / `@acp-kit/spar` now refreshes AUTHOR and REVIEWER ACP sessions independently after `AUTHOR_SESSION_TURNS` / `REVIEWER_SESSION_TURNS` turns, defaulting to 20 turns per role.
- `@acp-kit/author-reviewer-loop` / `@acp-kit/spar` defaults to 20 review rounds, keeps TUI wrapping enabled by default, and updates Codex presets to `gpt-5.5`, `gpt-5.4/medium`, `gpt-5.4/high`, and `gpt-5.5/xhigh` with `gpt-5.5` as the default Codex reviewer model.
- `@acp-kit/author-reviewer-loop` / `@acp-kit/spar` TUI animation updates now avoid full-screen redraw churn while preserving terminal-title animation, pane progress animation, and the launching boxing-glove header animation.

### Fixed

- `@acp-kit/core` resolves scoped and unscoped package fallback bins from the project/runtime install tree before falling back to raw `npx`, improving globally installed Spar startup behavior.
- `@acp-kit/core` local filesystem reads now return fresh on-disk content after edits instead of serving stale file text.
- `@acp-kit/author-reviewer-loop` / `@acp-kit/spar` fixes relative task-file resolution, reviewer prompt scope, approval continuation UI behavior, startup status duplication, long plain-renderer line wrapping, thinking/text delta stitching, TUI model-title truncation, startup-profile TUI noise, and several launch/wait/run status regressions.

## [0.6.13] - 2026-04-30

### Added

- `@acp-kit/core` now prepares package-based ACP fallback adapters into a persistent user cache before spawning them, so missing local wrappers such as `claude-code-acp` and `codex-acp` do not require repeated cold `npx --yes ...@latest` launches. Startup profiling now records fallback package preparation and first adapter stdout/stderr timing.
- `@acp-kit/author-reviewer-loop` startup profiling now covers role startup and first-turn latency so slow adapter launches and first response delays can be diagnosed from `ACP_STARTUP_PROFILE=1` output.

### Changed

- `@acp-kit/author-reviewer-loop` starts the AUTHOR turn as soon as the AUTHOR role is ready while the REVIEWER role continues launching in the background, reducing time-to-first-author-token when the REVIEWER adapter is slower to initialize.

### Fixed

- `@acp-kit/core` command lookup is cached across process starts and handles Windows npm/nvm shims more reliably, including PowerShell `.ps1` launchers.
- `@acp-kit/core` startup diagnostics now retain stdout, launch source, resolved command, lookup duration, npx fallback usage, and first output timing for easier adapter startup debugging.
- `@acp-kit/author-reviewer-loop` preserves aggregated startup errors when both roles fail while still allowing the AUTHOR to begin before a slow REVIEWER finishes launching.
- `@acp-kit/author-reviewer-loop` TUI regressions around task wrapping, thinking text rendering, tool-call folding, token usage display, terminal title animation, approval exit behavior, and launch/wait/run animation state were tightened.

## [0.6.12] - 2026-04-29

### Added

- The author/reviewer Spar CLI has been **renamed on npm** from `@acp-kit/author-reviewer-loop` to **`@acp-kit/spar`**, with a single shorter `spar` bin. The old package name will be deprecated on npm with a pointer to the new one; existing installs continue to work but new installs should use `npm i -g @acp-kit/spar`.
- `spar` now performs a best-effort startup update check against the npm registry. When a newer stable release is available it prompts `Update now via npm install -g @acp-kit/spar? [y/N]` and runs the global install if the user presses `y`. The check is silent on failure, skipped on non-TTY stdio and under CI, bypassable via `SPAR_NO_UPDATE_CHECK=1`, and cached locally for 6 hours to avoid hitting the registry on every launch.

## [0.6.11] - 2026-04-29

### Added

- `@acp-kit/core` now emits ACP `plan`, `reasoning`, tool `locations`, and tool structured `content` through the normalized event stream and transcript reducer. New runtime event `session.plan.updated` carries the latest `Plan` for a session; `tool.start` / `tool.update` / `tool.end` now carry `locations` and `content`. The transcript records `currentPlan` per session and `content` per tool record.
- `@acp-kit/author-reviewer-loop` reframed as **Spar**: TUI now shows a centered `Spar` brand line with two boxing-glove emojis that spar in toward the title and clash on the impact frame while agents are launching, in place of the previous `ACP Author/Reviewer Loop` header. All user-facing strings (finish view, launch confirmation, plain renderer divider, CLI confirm prompt) now say `Spar`. The npm package name is unchanged in this release.
- `@acp-kit/author-reviewer-loop` TUI dedicates a section to streaming agent reasoning (─ thinking · \<id\> ─ with ▎ prefixed lines) and shows a per-pane plan summary line (`Plan c/t  ✓✓→·· · in progress: <step>`) when the agent emits a plan.

### Changed

- `@acp-kit/author-reviewer-loop` TUI focused pane is now drawn with a double-line border (`╔═╗║╚╝`) plus bold rails, while the inactive pane keeps the thin round border (`╭─╮│╰╯`), so the active pane is obvious at a glance. Pane top-border title is centered between the corners.
- `@acp-kit/author-reviewer-loop` TUI tool selection (`[` / `]`): when the selected tool lives inside a folded tool-run, that run is automatically expanded inline so the selection is visible. The selected tool row is marked with a `▶` arrow plus bold yellow text instead of an inverse block, which is far easier to spot.
- `@acp-kit/author-reviewer-loop` TUI finish view no longer renders a progress bar or `Closing TUI...` pulse on approval; it shows a static APPROVED card and exits on the next tick, so the run feels finished rather than still in flight.
- Documentation site renames the *Author/Reviewer Loop* sidebar entry and page to **Spar** (`docs/spar.md`); the page now positions Spar as a flagship CLI built on `@acp-kit/core`.

## [0.6.10] - 2026-04-29

### Fixed

- `@acp-kit/author-reviewer-loop` TUI no longer crashes with `ReferenceError: animationFrame is not defined` on first render. The `animationLabel` helper had been hoisted out of the `App` component scope but still referenced the React `useState` value `animationFrame`; it now takes the frame as an explicit argument and the `Pane` component passes it in.
- `@acp-kit/author-reviewer-loop` engine reducer now indexes the previous pane's tool calls by id with a `Map` instead of a linear `find` per tool, and preserves tool calls that were live in earlier snapshots but missing from the latest snapshot, so long-running tool entries no longer disappear from the TUI when the agent emits a snapshot that omits them. New `tool.input` / `tool.output` from the snapshot now win over the previously cached values instead of being dropped.
- `@acp-kit/author-reviewer-loop` engine reducer now merges streaming reasoning deltas into the correct existing reasoning block by `sourceId` using `findLastIndex`, so reasoning chunks that arrive after intervening text or tool flow items are appended to the originating block instead of starting a new orphan block.
- `@acp-kit/author-reviewer-loop` TUI task header now measures the truncation hint with `displayWidth` and `fitText` so wide / CJK characters in the task title no longer push the `[v view full task, e edit]` hint past the terminal edge.
- `@acp-kit/author-reviewer-loop` TUI reasoning rows now use a plain-text `think:` prefix instead of an emoji, and the wrapping width is reduced by the prefix width so long reasoning lines wrap correctly inside the pane.
- `@acp-kit/author-reviewer-loop` TUI pane border (top label and bottom usage / timing label) now uses `displayWidth` for fill calculation so wide labels no longer leave gaps or overflow the border row.

## [0.6.9] - 2026-04-29

### Fixed

- `@acp-kit/author-reviewer-loop` TUI no longer crashes with `RangeError: Invalid array length` when a pane's flow ends on a tool item. `isBlankTextFlow(undefined)` previously returned `true`, causing the tool-run coalescing loop in `visibleFlowRows` to never terminate at end-of-flow and grow `skipped` until allocation failed. The helper now returns `false` for missing items so the loop stops at the array boundary.

## [0.6.8] - 2026-04-29

### Added

- `@acp-kit/author-reviewer-loop` TUI now ships an in-app agent and model picker for AUTHOR and REVIEWER, persisting the selection to `~/.acp-author-reviewer-loop.json` so subsequent runs reuse the same choices unless overridden by `AUTHOR_AGENT` / `AUTHOR_MODEL` / `REVIEWER_AGENT` / `REVIEWER_MODEL` env vars. CLI mode still uses built-in defaults; TUI mode no longer hard-codes them.
- `@acp-kit/author-reviewer-loop` exposes `agentChoices`, `modelChoices`, `defaultModelForAgent`, `modelChoicesForAgent`, and `applyRoleSelection` from the agents config module so the TUI selection screen and tests can share one source of truth.
- `@acp-kit/author-reviewer-loop` engine now also forwards `reasoningDelta` and `reasoningCompleted` events to the renderer, and threads `turnCompleted` / `turnFailed` / `turnEnd` through the trace pipeline so the TUI can display per-flow turn lifecycle markers.
- `@acp-kit/author-reviewer-loop` engine state now tracks pane `startedAt` / `finishedAt` / `durationMs` and uses dedicated `launching` / `waiting` statuses for clearer TUI run state.
- New documentation page [docs/author-reviewer-loop](https://acpkit.github.io/acp-kit/author-reviewer-loop) describing the demo, why single-agent self-review fails, the renderers, and the diagnostics env vars. Linked from the docs sidebar.

### Changed

- `@acp-kit/author-reviewer-loop` default CLI models updated to `gpt-5.4` for both AUTHOR and REVIEWER.
- `@acp-kit/author-reviewer-loop` plain and TUI renderers now display token usage as `ctx X/Y Tk` (context window from `usage_update`) and `Σ in:N out:N` (cumulative session totals from `PromptResponse.usage`), joined with `·`, instead of the previous ambiguous `In/Out`/`Used` labels. A header comment in each renderer documents the two ACP sources.
- `@acp-kit/author-reviewer-loop` reviewer prompt now asks for actionable suggestions with concrete fix guidance, and the author prompt now reminds the AUTHOR to fix root causes and validate when practical.
- `@acp-kit/author-reviewer-loop` package `homepage` now points at the new dedicated docs page.
- `release-prep` skill rewritten to drop dedicated `Release X.Y.Z` commits: releases now ride on top of normal development commits and are marked solely by the tag.

### Fixed

- `@acp-kit/core` `collectTurnResult` now folds the session transcript's session usage into the final result and no longer lets a follow-up usage update with a zero `used` overwrite a positive prior value when `size` is unchanged.
- `@acp-kit/core` `normalizeAcpUpdate` accepts ACP `usage_update` payloads that report `currentTokens` / `tokenLimit` (and snake_case variants) in addition to `used` / `size`.
- `@acp-kit/core` `resolveCommandOnPath` resolves Windows PowerShell `.ps1` shims even when `PATHEXT` omits `.PS1`, fixing agent detection for installs that ship PowerShell launchers.
- `@acp-kit/author-reviewer-loop` agent availability pre-flight is now skipped when the relevant role has not been chosen yet (TUI selection mode) and runs at TUI launch time once the choice is made.
- `@acp-kit/author-reviewer-loop` engine reducer tolerates partial pane snapshots and missing duration fields without throwing.

## [0.6.7] - 2026-04-28

### Fixed

- `@acp-kit/author-reviewer-loop` now passes the AUTHOR's reply for each round into the REVIEWER's prompt builder as `authorReply`, and the default reviewer prompt explicitly tells the REVIEWER to re-read every file the AUTHOR claims to have changed before judging. Previously the REVIEWER only saw the original task plus its own prior feedback and would frequently report "no changes" or treat each round as an unrelated codebase.
- `@acp-kit/author-reviewer-loop` now subscribes directly to the canonical normalized `session.usage.updated` event for token accounting, instead of trying to extract usage out of inspector wire frames. This makes the TUI token header and the plain renderer `[role usage]` line work in the default run mode without needing trace capture.
- `@acp-kit/author-reviewer-loop` TUI now batches engine-driven re-renders to ~50 ms frames during streaming, eliminating the lower-half flicker that occurred when message deltas, snapshots, tool events, and trace entries arrived in fast bursts. `result` and `error` actions still flush immediately.
- `@acp-kit/author-reviewer-loop` legacy `runAuthorReviewerLoop` adapter now also forwards `turnSnapshot`, `traceEntry`, and `usageUpdate` engine events to the renderer, matching what the engine publishes.
- `@acp-kit/author-reviewer-loop` reducer's standalone `usageUpdate` action now updates both the cumulative role usage and the active round pane, so token counts shown by the TUI refresh as soon as a usage update arrives, not only on the next turn snapshot.
- `@acp-kit/core` `normalizeAcpUpdate` now accepts ACP `usage_update` payloads that report `currentTokens` / `tokenLimit` (and snake_case variants) in addition to `used` / `size`, so context-window data from agents that use the alternate field names is no longer dropped.
- `@acp-kit/core` `collectTurnResult` now folds the session transcript's session usage into the final result and no longer lets a follow-up usage update with a zero `used` overwrite a positive prior value when `size` is unchanged.

### Added

- `@acp-kit/author-reviewer-loop` plain renderer prints a `[role usage] In/Out … Tk` (or `Used … Tk`) line whenever an agent reports new token usage, deduplicated against the previous line for the same role.
- `@acp-kit/author-reviewer-loop` exposes an `ACP_REVIEW_DEBUG_USAGE=1` diagnostic env var that writes each received `session.usage.updated` event to stderr for confirming whether the agent emits ACP usage data at all.
- A local `release-prep` skill under `.github/skills/release-prep/SKILL.md` documenting the end-to-end release workflow used for ACP Kit.

## [0.6.6] - 2026-04-28

### Fixed

- `@acp-kit/author-reviewer-loop` now gives explicit renderer flags predictable precedence: `--cli` selects the plain renderer even when the legacy `ACP_REVIEW_TUI=1` compatibility flag is present, while `--tui` can still override `ACP_REVIEW_CLI=1`.
- `@acp-kit/author-reviewer-loop` CLI configuration errors, such as unsupported `AUTHOR_AGENT` / `REVIEWER_AGENT` values, are now reported through the normal startup formatter instead of leaking an uncaught stack trace before the CLI error handler is installed.
- `@acp-kit/author-reviewer-loop` reviewer prompts now include the current round and previous reviewer feedback passed by the engine, so later review rounds have explicit context about what was already requested.
- `@acp-kit/author-reviewer-loop` turn collection failures that happen before an ACP `turn.failed` / `turn.cancelled` event now emit a renderer `turnFailed` event before the error propagates.

### Changed

- Rebuilt the recent changelog history so the `0.6.1` through `0.6.5` entries reflect the actual package, runtime, renderer, documentation, and test changes shipped in those releases.
- Added a package-local `@acp-kit/author-reviewer-loop` changelog and included it in the package's published files.

## [0.6.5] - 2026-04-28

### Added

- `@acp-kit/author-reviewer-loop` task input can now be inline text or a relative/absolute UTF-8 task file; file input is read once at startup and the resolved source is shown in run summaries.
- The Ink TUI is now the default renderer. `--cli` / `ACP_REVIEW_CLI=1` select the plain renderer, while `--tui` / `ACP_REVIEW_TUI=1` remain accepted for compatibility.
- TUI users can edit the task in an external editor before launch or after reviewer approval, then continue the same AUTHOR/REVIEWER sessions with the updated task.
- TUI users can force another AUTHOR/REVIEWER round after reviewer approval without editing the task.
- TUI panes now show cumulative input/output token usage when agents report ACP usage data.
- TUI tool-call navigation now supports selecting concrete tool calls with `[` / `]` and opening a full input/output detail view with `Enter` / `d`.
- `@acp-kit/author-reviewer-loop` now has focused Vitest coverage for CLI config parsing, engine approval continuation, runtime role cleanup, turn failure cleanup, and state reduction.

### Fixed

- `@acp-kit/author-reviewer-loop` bounds retained raw ACP trace entries by both entry count and serialized byte size so trace-heavy runs do not grow UI state without limit.
- `@acp-kit/author-reviewer-loop` state reduction now tolerates partial turn snapshots and missing tool character counts without throwing or producing `NaN`.
- `@acp-kit/author-reviewer-loop` cleans up created sessions, spawned terminals, and runtimes when model setup fails during role startup.
- `@acp-kit/core` command detection now handles Windows path extensions and command lookup edge cases more reliably.
- `@acp-kit/core` normalized events and turn-result collection cover additional edge cases for missing text, usage updates, and terminal tool metadata.

### Changed

- `@acp-kit/author-reviewer-loop` moved pane, trace, usage, and result bookkeeping into a dedicated reducer module shared by renderers.
- `@acp-kit/author-reviewer-loop` README and site docs now describe the default TUI, plain renderer opt-in, task-file input, task editing, tool detail view, token usage display, and editor timeout environment variable.
- `@acp-kit/core` docs and runtime examples were refreshed for the renamed AcpKit organization and the current agent matrix.

## [0.6.4] - 2026-04-27

### Added

- `detectInstalledAgents(...)` and `isCommandOnPath(...)` in `@acp-kit/core` for fast, side-effect-free agent availability checks.
- `@acp-kit/author-reviewer-loop` now checks configured AUTHOR and REVIEWER agents before prompting or launching the loop, while preserving runtime fallback command behavior.

### Fixed

- `@acp-kit/core` Node transport now reuses the shared command detection helper instead of duplicating lookup logic.

### Changed

- Author/reviewer loop success output is more visually distinct in both plain and TUI renderers.

## [0.6.3] - 2026-04-27

### Added

- Built-in agent profiles now launch local agent binaries first and fall back to their `npx ...@latest` commands when the binary is not on `PATH`.
- `@acp-kit/author-reviewer-loop` now gives hosted demo agents local file-system and terminal capabilities rooted at the selected workspace, with trace capture available in both plain and TUI renderers.
- `@acp-kit/author-reviewer-loop` renderers now show compact command/input and output previews for tool calls, collapse large continuous tool-call bursts, and expose a raw ACP trace view in the TUI.
- `@acp-kit/core` added broad edge-case test coverage for agent profile fallback, startup diagnostics, runtime inspection, recordings, normalization, sessions, transcripts, and turn-result collection.

### Fixed

- Node child-process transport now handles spawn errors such as `ENOENT` without crashing the host process and records the failure in startup diagnostics.
- Runtime inspector and diagnostic capture now handle large or unusual wire frames more robustly.

### Changed

- Agent docs and compatibility issue templates now document the fast local command names while noting the automatic `npx` fallback behavior.
- `@acp-kit/author-reviewer-loop` now captures trace data for TUI runs even when `ACP_REVIEW_TRACE` is not printing JSONL to stderr, enabling the in-app trace view.

## [0.6.2] - 2026-04-27

### Added

- `collectTurnResult(session, prompt, options)` in `@acp-kit/core`, a turn-level helper that collects streaming session events into one result object while still exposing live `onEvent` and `onUpdate` callbacks for UIs.
- `@acp-kit/author-reviewer-loop` now has a renderer-agnostic loop engine plus plain and Ink TUI renderers.
- `@acp-kit/author-reviewer-loop --tui` for a fullscreen split-pane AUTHOR/REVIEWER view with round navigation, pane scrolling, and soft wrapping.
- `@acp-kit/author-reviewer-loop` now includes modular CLI helpers for argument/env parsing, confirmation prompts, run summaries, startup error formatting, shell-specific environment examples, runtime role startup, and per-turn event normalization.
- `@acp-kit/author-reviewer-loop` keeps the legacy `runAuthorReviewerLoop({ config, renderer })` adapter for callers that used the earlier single-file demo shape.
- Core and package documentation now include `collectTurnResult(...)` and the author/reviewer loop architecture.

### Changed

- `@acp-kit/author-reviewer-loop` now uses `commander` for CLI parsing and keeps CLI, config, runtime, engine, and renderer code in separate modules.
- The author/reviewer loop validates configured models during startup. If an agent reports available models and the configured model is invalid, the CLI fails before the first turn and prints the available model ids plus shell-appropriate environment variable examples.
- The TUI header now combines author/reviewer agent, model, and status into one status row; long task text and pane output are wrapped for readability.
- The author/reviewer package now declares optional `ink` and `react` dependencies for TUI mode while keeping the plain renderer lazy-loaded and lightweight.

## [0.6.1] - 2026-04-27

### Added

- New `@acp-kit/author-reviewer-loop` package, a runnable split-context `npx` demo where an AUTHOR agent modifies files and a REVIEWER agent inspects them in a separate context until `APPROVED`.
- The package ships `acp-author-reviewer-loop` and `author-reviewer-loop` bin aliases, default Copilot AUTHOR / Codex REVIEWER profiles, model and round configuration through environment variables, confirmation prompts, and README usage docs.

### Changed

- Replaced the old `examples/pair-programming/` folder with the publishable `packages/author-reviewer-loop/` CLI package.
- Repository release automation and package metadata were updated so `@acp-kit/author-reviewer-loop` can be published alongside `@acp-kit/core`.

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

- New **`examples/pair-programming/`** &mdash; two ACP agents (AUTHOR + REVIEWER) collaborating on the same `cwd` until the reviewer says `APPROVED`. Demonstrates per-role profile + model + prompt settings, parallel agent launch, and handler-map event dispatch.
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
