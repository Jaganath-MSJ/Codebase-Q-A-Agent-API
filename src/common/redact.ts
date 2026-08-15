// PURE — no I/O. Tokens end up in logs and persisted error messages through
// a caught exception's .message far more often than through deliberate
// logging (e.g. a git subprocess echoing a bad credential back in its own
// error text), so this is applied at the one place indexing job failures
// become both a log line and a stored `indexing_jobs.error_message`
// (WorkerService.recordFailure), not as a general-purpose logging filter
// this codebase doesn't otherwise have infrastructure for.
const TOKEN_PATTERNS = [
  /gh[pousr]_[A-Za-z0-9]{36}/g, // classic GitHub PATs, OAuth/user/server-to-server tokens
  /github_pat_[A-Za-z0-9_]{22,}/g, // fine-grained GitHub PATs
];

export function redactSecrets(text: string): string {
  return TOKEN_PATTERNS.reduce((redacted, pattern) => redacted.replace(pattern, '[REDACTED]'), text);
}
