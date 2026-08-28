/**
 * Settled tool-outcome classification for the client. One canonical
 * vocabulary across chat rows and the trajectory view: a settled tool call is
 * `success`, `stopped` (cancelled/interrupted by user or parent), `blocked`
 * (the harness or a policy refused the call, or the model's request was
 * correctable), or `error` (the call actually failed). Classification reads
 * only the structured durable facts — `isError` and `error.code` — never the
 * model-facing text.
 * @module @deepseek-ai/dsh-client-runtime/client/tool-outcome
 */

/** Settled tool-call outcome; `running` is not settled and never appears here. */
export type ToolOutcomeKind = 'success' | 'stopped' | 'blocked' | 'error'

/** Durable structured failure identity carried by `tool/result.error` (`name` + stable `code`). */
export interface ToolOutcomeError {
  readonly name: string
  readonly code: string
}

/** Classifier input: the settled call's failure flag and optional durable error. */
export interface ToolOutcomeInput {
  readonly isError: boolean
  readonly error?: ToolOutcomeError | undefined
}

/**
 * Stable codes whose meaning is "the call was cancelled or interrupted" —
 * including the client-synthesized `interrupted` code (the legacy marker the
 * Conversation Tool Definitions project when a running call's step/turn
 * closed without a result) and the reserved approval/sandbox escalation
 * cancellation codes.
 */
const STOPPED_CODES: ReadonlySet<string> = new Set([
  'ABORTED',
  'ABORTED_BEFORE_DISPATCH',
  'TOOL_NOT_STARTED',
  'TOOL_OUTCOME_UNKNOWN',
  'ASK_ABORTED',
  'ASK_CANCELLED',
  'interrupted',
  'TOOL_APPROVAL_CANCELLED',
  'SANDBOX_ESCALATION_CANCELLED',
])

/**
 * Stable codes whose meaning is "the call was refused or its request was
 * correctable": policy/approval denials, post-policy blocks, sandbox
 * escalation refusals, and model-correctable conditions (`INVALID_ARGS`,
 * `UNKNOWN_TOOL`, and the `GOAL_TOOL_*` family). These never entered the tool
 * body as a real execution.
 */
const BLOCKED_CODES: ReadonlySet<string> = new Set([
  'INVALID_ARGS',
  'UNKNOWN_TOOL',
  'TOOL_POLICY_DENIED',
  'TOOL_APPROVAL_BLOCKED',
  'TOOL_APPROVAL_REJECTED',
  'TOOL_APPROVAL_UNAVAILABLE',
  'TOOL_POST_BLOCKED',
  'SANDBOX_ESCALATION_BLOCKED',
  'SANDBOX_ESCALATION_REJECTED',
  'SANDBOX_ESCALATION_UNAVAILABLE',
  // Filesystem and search conditions the model can act on by retrying or
  // correcting its input (listed explicitly — no broad FS_/SEARCH_ prefix).
  'FS_NOT_FOUND',
  'FS_NOT_OBSERVED',
  'FS_STALE_VERSION',
  'SEARCH_INVALID_PATTERN',
  'SEARCH_RAW_OUTPUT_OVERFLOW',
])

/** Codes in the model-correctable `GOAL_TOOL_*` family classify as blocked. */
const GOAL_TOOL_BLOCKED_PREFIX = 'GOAL_TOOL_'

/**
 * Classify one settled tool call from its durable facts only. A successful
 * call is `success`; a failed call is `stopped` when its code is a
 * cancellation/interruption, `blocked` when its code is a refusal or a
 * correctable condition, and `error` for every unknown or uncoded failure.
 * @param input - the settled call's `isError` flag and optional `error` code.
 * @returns the outcome kind.
 */
export function toolOutcomeKind(input: ToolOutcomeInput): ToolOutcomeKind {
  if (!input.isError) return 'success'
  const code = input.error?.code
  if (code !== undefined) {
    if (STOPPED_CODES.has(code)) return 'stopped'
    if (BLOCKED_CODES.has(code) || code.startsWith(GOAL_TOOL_BLOCKED_PREFIX)) return 'blocked'
  }
  return 'error'
}
