import process from 'node:process';

/**
 * Plain console renderer. Subscribes to engine events and prints them as a
 * scrolling line-based log with compact tool-call details. Bookkeeping lives
 * in the engine; this renderer only formats the event stream.
 */
export function createPlainRenderer() {
  let midLine = false;
  let textColorActive = false;
  let textParagraph = 0;
  let lineHasText = false;

  const ansiCodes = {
    gray: 90,
    yellow: 33,
    green: 32,
    red: 31,
    blue: 34,
    magenta: 35,
    cyan: 36,
    white: 37,
  };

  const color = (name, text) => {
    if (!process.stdout.isTTY) return text;
    return `\u001b[${ansiCodes[name]}m${text}\u001b[0m`;
  };

  const paragraphPalette = ['white', 'cyan', 'green', 'yellow', 'blue'];
  const paragraphColor = () => paragraphPalette[textParagraph % paragraphPalette.length];
  const resetColor = () => {
    if (process.stdout.isTTY && textColorActive) {
      process.stdout.write('\u001b[0m');
      textColorActive = false;
    }
  };

  const toolColor = (status) => {
    if (status === 'failed' || status === 'error') return 'red';
    if (status === 'completed' || status === 'done' || status === 'success') return 'green';
    return 'yellow';
  };

  const toolStatusLabel = (status) => status === 'completed' ? 'done' : status;
  const divider = (label = '') => {
    const width = Math.max(32, Math.min(80, process.stdout.columns || 80));
    const text = label ? ` ${label} ` : '';
    const fill = Math.max(0, width - text.length);
    const left = Math.floor(fill / 2);
    return `${'─'.repeat(left)}${text}${'─'.repeat(fill - left)}`;
  };
  let toolBurstCount = 0;
  let toolBurstHidden = 0;
  const lastUsageByRole = new Map();
  const reasoningNumbersByRole = new Map();
  const nextReasoningNumberByRole = new Map();

  const reasoningNumber = (role, reasoningId) => {
    if (!reasoningId) return null;
    const roleKey = String(role || 'unknown');
    const byId = reasoningNumbersByRole.get(roleKey) ?? new Map();
    if (byId.has(reasoningId)) return byId.get(reasoningId);
    const next = (nextReasoningNumberByRole.get(roleKey) ?? 0) + 1;
    byId.set(reasoningId, next);
    reasoningNumbersByRole.set(roleKey, byId);
    nextReasoningNumberByRole.set(roleKey, next);
    return next;
  };

  const reasoningLabel = (role, reasoningId, noun = 'thinking') => {
    const number = reasoningNumber(role, reasoningId);
    return number ? `${noun} #${number}` : noun;
  };

  const stringifyValue = (value) => {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    const seen = new WeakSet();
    return JSON.stringify(value, (key, item) => {
      if (typeof item === 'bigint') return String(item);
      if (typeof item === 'object' && item !== null) {
        if (seen.has(item)) return '[Circular]';
        seen.add(item);
      }
      return item;
    }) || '';
  };

  const compactWhitespace = (text) => String(text || '').replace(/\s+/g, ' ').trim();
  const truncateText = (text, max) => {
    const value = compactWhitespace(text);
    if (value.length <= max) return value;
    return `${value.slice(0, Math.max(0, max - 1))}\u2026`;
  };

  const findField = (value, names, depth = 0) => {
    if (value == null || depth > 4 || typeof value === 'string') return '';
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = findField(item, names, depth + 1);
        if (found) return found;
      }
      return '';
    }
    if (typeof value !== 'object') return '';
    for (const [key, item] of Object.entries(value)) {
      if (names.includes(key) && (typeof item === 'string' || typeof item === 'number')) return String(item);
    }
    for (const item of Object.values(value)) {
      const found = findField(item, names, depth + 1);
      if (found) return found;
    }
    return '';
  };

  const summarizeValue = (value, max = 90) => {
    if (value == null) return '';
    const command = findField(value, ['command', 'cmd', 'shellCommand', 'script']);
    if (command) return truncateText(command, max);
    return truncateText(stringifyValue(value), max);
  };

  const lineCount = (value) => {
    if (value == null) return 0;
    const text = typeof value === 'string' ? value : stringifyValue(value);
    if (!text) return 0;
    return text.split('\n').length;
  };

  const formatToolSize = ({ lines = 0, chars = 0 } = {}) => {
    const parts = [];
    if (Number.isFinite(lines) && lines > 0) parts.push(`${lines} ${lines === 1 ? 'line' : 'lines'}`);
    if (Number.isFinite(chars) && chars > 0) parts.push(`${chars} chars`);
    return parts.join(' · ');
  };

  const summarizeTool = (event, { includeOutput = false } = {}) => {
    const parts = [`  [tool ${event.tag} ${toolStatusLabel(event.status || 'running')}]`];
    if (event.title) parts.push(event.title);
    const input = summarizeValue(event.input);
    if (input) parts.push(`cmd: ${input}`);
    if (includeOutput) {
      const output = summarizeValue(event.output, 70);
      if (output) parts.push(`out: ${output}`);
      const size = formatToolSize({ lines: lineCount(event.output), chars: event.chars });
      if (size) parts.push(size);
    }
    return parts.join(' ');
  };

  const wrapLine = (text, cols = process.stdout.columns || 80) => {
    const width = Math.max(20, cols - 2);
    if (text.length <= width) return [text];
    const rows = [];
    let rest = text;
    while (rest.length > width) {
      const cut = rest.lastIndexOf(' ', width);
      if (cut <= 0) {
        rows.push(rest.slice(0, width));
        rest = rest.slice(width);
        continue;
      }
      rows.push(rest.slice(0, cut).trimEnd());
      rest = `  ${rest.slice(cut).trimStart()}`;
    }
    if (rest) rows.push(rest);
    return rows;
  };

  const logTool = (status, message) => {
    for (const row of wrapLine(message)) {
      console.log(color(toolColor(status), row));
    }
  };

  const flushToolBurst = () => {
    if (toolBurstHidden > 0) {
      logTool('running', `  [tools] ${toolBurstHidden} additional continuous tool events hidden; use --tui and press t for raw ACP details`);
    }
    toolBurstCount = 0;
    toolBurstHidden = 0;
  };

  const logToolBurst = (status, message) => {
    toolBurstCount += 1;
    if (toolBurstCount <= 3) {
      logTool(status, message);
      return;
    }
    if (toolBurstCount === 4) {
      logTool(status, '  [tools] continuous tool events collapsed after 3 lines');
      return;
    }
    toolBurstHidden += 1;
  };

  const lineFeed = () => {
    if (midLine) {
      resetColor();
      process.stdout.write('\n');
      midLine = false;
      lineHasText = false;
    }
  };

  const formatTokenCount = (tokens) => {
    if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`;
    if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1).replace(/\.?0+$/, '')}K`;
    return String(tokens);
  };

  // Two distinct numbers can arrive for one role:
  //   * inputTokens / outputTokens are CUMULATIVE session totals reported by
  //     ACP `PromptResponse.usage` (sum across all turns so far).
  //   * used / size are a CONTEXT-WINDOW snapshot reported by ACP
  //     `usage_update` (tokens currently in context vs. context window size).
  // Show whichever is available; show both when both are.
  const formatUsage = (usage) => {
    const parts = [];
    const used = Number.isFinite(usage?.used) ? usage.used : 0;
    const size = Number.isFinite(usage?.size) ? usage.size : 0;
    if (used > 0 || size > 0) {
      parts.push(`ctx ${formatTokenCount(used)}/${formatTokenCount(size)} Tk`);
    }
    const input = Number.isFinite(usage?.inputTokens) ? usage.inputTokens : 0;
    const output = Number.isFinite(usage?.outputTokens) ? usage.outputTokens : 0;
    if (input > 0 || output > 0) {
      parts.push(`\u03A3 in:${formatTokenCount(input)} out:${formatTokenCount(output)}`);
    }
    return parts.join(' \u00B7 ');
  };

  const logUsage = ({ role, usage }) => {
    const label = formatUsage(usage);
    if (!label) return;
    const previous = lastUsageByRole.get(role);
    if (previous === label) return;
    lastUsageByRole.set(role, label);
    lineFeed();
    console.log(color('gray', `  [${role.toLowerCase()} usage] ${label}`));
  };

  const writeReasoningDelta = (event) => {
    if (!event.delta) return;
    const label = reasoningLabel(event.role, event.reasoningId);
    if (!midLine) process.stdout.write(color('gray', `\n  [${event.role.toLowerCase()} ${label}] `));
    process.stdout.write(color('gray', event.delta.replace(/\n/g, `\n  [${label}] `)));
    midLine = !event.delta.endsWith('\n');
  };

  /**
   * Print a one-line summary at the end of a reasoning block so users can see
   * the final shape of the model's "thinking" without rereading every delta.
   */
  const logReasoningSummary = (event) => {
    const text = typeof event?.content === 'string' ? event.content : '';
    if (!text) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    const charCount = text.length;
    const role = (event.role ?? '').toLowerCase();
    const label = reasoningLabel(event.role, event.reasoningId, 'thought');
    console.log(color('gray', `  [${role} ${label}] ${charCount} chars`));
  };

  const planGlyph = (status) => {
    if (status === 'completed') return color('green', '✓');
    if (status === 'in_progress') return color('yellow', '→');
    if (status === 'failed' || status === 'cancelled') return color('red', '✗');
    return color('gray', '·');
  };

  const lastPlanByRole = new Map();
  /**
   * Render a compact plan diff line per `session/update plan` notification.
   * Plans are session-level, but we print them per role so users can tell
   * whose execution plan changed in interleaved transcripts. We dedupe
   * identical successive plans (some agents repost plans on every turn).
   */
  const logPlan = ({ role, entries }) => {
    if (!Array.isArray(entries) || entries.length === 0) return;
    const fingerprint = entries.map((e) => `${e?.status ?? '?'}:${e?.content ?? ''}`).join('|');
    if (lastPlanByRole.get(role) === fingerprint) return;
    lastPlanByRole.set(role, fingerprint);
    const completed = entries.filter((e) => e?.status === 'completed').length;
    const total = entries.length;
    const summary = entries
      .slice(0, 6)
      .map((entry) => `${planGlyph(entry?.status)} ${entry?.content ?? ''}`)
      .join('  ');
    const overflow = entries.length > 6 ? ` (+${entries.length - 6} more)` : '';
    console.log(color('cyan', `  [${role.toLowerCase()} plan ${completed}/${total}] ${summary}${overflow}`));
  };

  const writeTextDelta = (delta) => {
    if (!process.stdout.isTTY) {
      process.stdout.write(delta);
      midLine = !delta.endsWith('\n');
      return;
    }

    for (const char of delta) {
      if (char === '\n') {
        resetColor();
        process.stdout.write(char);
        if (!lineHasText) textParagraph += 1;
        lineHasText = false;
        midLine = false;
        continue;
      }

      if (!textColorActive) {
        process.stdout.write(`\u001b[${ansiCodes[paragraphColor()]}m`);
        textColorActive = true;
      }
      process.stdout.write(char);
      if (char.trim() !== '') lineHasText = true;
      midLine = true;
    }
  };

  return {
    /**
     * Wire this renderer to a loop engine. Returns the unsubscribe function.
     */
    attach(engine) {
      return engine.onEvent((event) => {
        switch (event.type) {
          case 'launching':
            flushToolBurst();
            console.log(color('cyan', divider('Spar')));
            console.log(color('gray', 'Launching agents in parallel. Cold starts can take a few seconds.'));
            return;
          case 'roleStatus':
            flushToolBurst();
            console.log(`  [${event.role.toLowerCase()}] ${event.message}`);
            return;
          case 'turnStart':
            flushToolBurst();
            console.log(`\n${color('cyan', divider(`Round ${event.round} · ${event.role}`))}`);
            return;
          case 'delta':
            flushToolBurst();
            writeTextDelta(event.delta);
            return;
          case 'reasoningDelta':
            flushToolBurst();
            writeReasoningDelta(event);
            return;
          case 'reasoningCompleted':
            lineFeed();
            logReasoningSummary(event);
            return;
          case 'toolStart':
            lineFeed();
            logToolBurst('running', summarizeTool(event));
            return;
          case 'toolUpdate':
            lineFeed();
            logToolBurst(event.status || 'running', summarizeTool(event, { includeOutput: true }));
            return;
          case 'toolEnd':
            lineFeed();
            logToolBurst(event.status, summarizeTool(event, { includeOutput: true }));
            return;
          case 'turnCompleted':
            flushToolBurst();
            lineFeed();
            console.log(`  (turn done: ${event.stopReason})`);
            return;
          case 'turnFailed':
            flushToolBurst();
            lineFeed();
            console.log(`  (turn failed: ${event.error})`);
            return;
          case 'turnEnd':
            flushToolBurst();
            lineFeed();
            return;
          case 'usageUpdate':
            flushToolBurst();
            logUsage(event);
            return;
          case 'planUpdate':
            flushToolBurst();
            lineFeed();
            logPlan(event);
            return;
          case 'result': {
            flushToolBurst();
            const { approved, feedback, maxRounds, cwd } = event.result;
            console.log(`\n${color(approved ? 'green' : 'yellow', divider(approved ? 'APPROVED' : 'NOT APPROVED'))}`);
            if (approved) console.log(`${color('green', '✓ Approved')} · Files under ${cwd}.\n`);
            else console.log(`${color('yellow', `Not approved after ${maxRounds} rounds.`)}\nLast feedback:\n${feedback}`);
            return;
          }
          default:
            return;
        }
      });
    },
  };
}
