# Spar Practical TODO

This is the short-list of practical Spar improvements that should be prioritized after the real-workspace enforcement work.

## Next

1. Fix CI regressions immediately when release or main workflows turn red.
2. Add `spar doctor` / `spar --doctor` to check agent availability, Node version, cwd writability, Claude `bypassPermissions` availability, Codex real-workspace launch config, and installed `spar --version`.
3. Detect real disk changes after AUTHOR turns. Prefer `git status` / `git diff --name-only` when `cwd` is a git repository; fall back to filesystem snapshots or mtime/hash checks when it is not.
4. Standardize the real-workspace adapter registry around explicit hooks: launch profile adaptation, post-session validation, post-session mode setup, and diagnostics summary.
5. Add optional real-agent smoke tests gated by an environment variable, for example `SPAR_REAL_AGENT_E2E=1`, so fake ACP coverage remains fast while real Claude/Codex integrations can be checked before release.
6. Emit a compact diagnostic bundle on failures: run config summary, real-workspace policy summary, run trace path, recent tool calls, agent launch diagnostics, and git/filesystem change summary.
7. Expand the README real-workspace section with Codex and Claude specifics, failure modes, and how to inspect run traces.

## Notes

- Reviewer prompts should treat the AUTHOR reply as a report to investigate, not as evidence. The reviewer should double-check actual files and use git only when the workspace is a git repository.
- Do not add a fresh/no-recovery mode for now.
