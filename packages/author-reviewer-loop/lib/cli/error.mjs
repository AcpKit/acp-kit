import { formatStartupDiagnostics, isAcpStartupError } from '@acp-kit/core';

export function formatStartupError(error) {
  if (isAcpStartupError(error)) {
    return formatStartupDiagnostics(error.diagnostics);
  }
  if (error instanceof Error && error.name === 'ConfigurationError') {
    return `Error: ${error.message}`;
  }
  if (error instanceof AggregateError) {
    const details = Array.isArray(error.errors) ? error.errors : [];
    const formatted = details
      .map((item, index) => formatNestedError(item, index + 1))
      .filter(Boolean)
      .join('\n\n');
    return formatted ? `${error.message}\n\n${formatted}` : error.message;
  }
  return error instanceof Error ? error.stack || error.message : String(error);
}

export function reportError(error) {
  console.error(formatStartupError(error));
}

function formatNestedError(error, index) {
  const label = `Cause ${index}:`;
  if (error instanceof Error) return `${label} ${error.stack || error.message}`;
  return `${label} ${String(error)}`;
}
