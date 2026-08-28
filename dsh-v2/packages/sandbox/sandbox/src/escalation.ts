/**
 * The escalation vocabulary and choreography shared by every sandbox-enforcing
 * tool family (`@deepseek-ai/dsh-tool-bash`, `@deepseek-ai/dsh-tool-fs`): the
 * strictly-wider ladder, the argument-pairing validation, the model-facing
 * denial/hint markers, and {@link approveEscalation} — the ordered fail-closed
 * sequence that resolves a `sandbox_permissions` request through a
 * user-approval channel BEFORE anything executes. One home keeps the two
 * families' approval ordering and verbatim error texts from drifting apart.
 *
 * The channel is a minimal STRUCTURAL function shape ({@link EscalationAsk}),
 * not the approval service type: the tool layer — which owns the agent, the
 * call id, and the tool name — closes over `ctx.approval.request(...)` and
 * hands the closure down, so this package never depends on the approval or
 * agent packages.
 *
 * @module dsh-sandbox/escalation
 */

import { assertNever, HarnessError } from '@deepseek-ai/dsh-llm'
import type { SandboxMode } from './index.ts'

/**
 * The strictly-wider table: what a call whose effective mode is the key may
 * escalate TO. Checked at EXECUTION, never baked into a tool schema — the
 * schema's enum is {@link ESCALATION_TARGETS}, because schemas are
 * registry-global while the effective mode is per-call truth.
 */
export const WIDER_MODES: Record<string, readonly SandboxMode[]> = {
  'read-only': ['workspace-write', 'danger-full-access'],
  'workspace-write': ['danger-full-access'],
}

/**
 * The closed escalation-target vocabulary — every mode a call could ever
 * escalate TO (`read-only` is the floor; nothing escalates to it). Advertised
 * whenever the mounted capability confines: cutting the enum down to the modes
 * wider than the composition's DEFAULT would strand a session whose effective
 * mode sits below it (a `danger-full-access` default would advertise nothing
 * while a narrower-switched session stays confined with no lever).
 */
export const ESCALATION_TARGETS: readonly SandboxMode[] = ['workspace-write', 'danger-full-access']

/**
 * Stable machine-routable failure codes for escalation resolution failures,
 * surfaced on {@link HarnessError} throws so tool results and replay retain a
 * failure class (`error.info.code`) instead of requiring message parsing:
 *
 * - `INVALID_ARGS` — malformed escalation arguments (an unpaired field or a
 *   blank justification), reusing the core invalid-arguments code so the
 *   client outcome classifier treats it as a correctable `blocked` call.
 * - `SANDBOX_ESCALATION_BLOCKED` — the approval policy deterministically
 *   blocks the request (the `'never'` policy) before any answerer sees it.
 * - `SANDBOX_ESCALATION_REJECTED` — a human or answerer explicitly rejected
 *   the request.
 * - `SANDBOX_ESCALATION_CANCELLED` — the request was withdrawn (aborted)
 *   before a decision.
 * - `SANDBOX_ESCALATION_UNAVAILABLE` — no approval service, no agent to
 *   route through, or the answerer chain resolved fail-closed.
 */
export const ESCALATION_ERROR_CODES = {
  invalidArgs: 'INVALID_ARGS',
  blocked: 'SANDBOX_ESCALATION_BLOCKED',
  rejected: 'SANDBOX_ESCALATION_REJECTED',
  cancelled: 'SANDBOX_ESCALATION_CANCELLED',
  unavailable: 'SANDBOX_ESCALATION_UNAVAILABLE',
} as const

/** One stable escalation failure code (see {@link ESCALATION_ERROR_CODES}). */
export type EscalationErrorCode = typeof ESCALATION_ERROR_CODES[keyof typeof ESCALATION_ERROR_CODES]

/**
 * Throw one stable-code escalation failure.
 * @param code - the stable {@link ESCALATION_ERROR_CODES} failure code carried on the result's `error.info`.
 * @param message - the human-readable failure message (verbatim in the tool result).
 * @returns a {@link HarnessError} carrying `code`; `name` is the shared `HarnessError`.
 */
export function escalationError(code: EscalationErrorCode, message: string): HarnessError {
  return new HarnessError(message, code)
}

/**
 * Validate the escalation argument pairing a tool schema cannot express:
 * `sandbox_permissions` and `justification` travel together — an approval
 * prompt without a reason, or a reason driving nothing, is a malformed ask —
 * and the justification must be a non-empty sentence.
 * @param sandboxPermissions - the raw `sandbox_permissions` argument, if given.
 * @param justification - the raw `justification` argument, if given.
 * @throws a {@link HarnessError} with code `INVALID_ARGS` for an unpaired
 *   field or a blank justification, so the failure stays routable
 *   (`error.info.code`) instead of message-only.
 */
export function validateEscalationArgs(sandboxPermissions: string | undefined, justification: string | undefined): void {
  if (sandboxPermissions !== undefined && justification === undefined) {
    throw escalationError(ESCALATION_ERROR_CODES.invalidArgs, 'invalid escalation: sandbox_permissions requires a justification')
  }
  if (justification !== undefined && sandboxPermissions === undefined) {
    throw escalationError(ESCALATION_ERROR_CODES.invalidArgs, 'invalid escalation: justification is only valid together with sandbox_permissions')
  }
  if (justification !== undefined && justification.trim().length === 0) {
    throw escalationError(ESCALATION_ERROR_CODES.invalidArgs, 'invalid justification: expected a non-empty sentence')
  }
}

/**
 * The model-facing denial marker — the one vocabulary both enforcing families
 * teach and report, so the model recognizes a policy denial identically
 * whether the kernel refused a bash file effect or the filesystem provider's
 * fence refused a mutation.
 * @param mode - the mode the denied call ran under.
 * @returns the marker line, exactly as the model sees it.
 */
export function sandboxDenialMarker(mode: SandboxMode): string {
  return `[sandbox: file access denied under ${mode} mode]`
}

/**
 * The same-turn escalation hint that rides a denial when the composition
 * advertises the escalation fields — the nudge lives at the decision point so
 * the sanctioned retry does not depend on the model recalling the tool
 * description.
 * @param subject - the family's noun for the denied action (`command` for
 *   bash, `operation` for a filesystem mutation).
 * @returns the hint line, exactly as the model sees it.
 */
export function escalationHintMarker(subject: string): string {
  return `[sandbox: escalation available — retry this exact ${subject} once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]`
}

/**
 * The closed outcome vocabulary of one escalation ask — structurally identical
 * to the approval seam's `ApprovalOutcome` so an `ApprovalService.request`
 * return is assignable without this package importing it. `blocked` is the
 * deterministic policy outcome (`'never'` policy), distinct from a human or
 * answerer `rejected`.
 */
export type EscalationOutcome = 'allowed-once' | 'rejected' | 'blocked' | 'cancelled' | 'unavailable'

/**
 * The minimal approval-request shape {@link approveEscalation} needs —
 * structurally the approval seam's `ApprovalService`, generic over the agent
 * type `A` and call-id type `C` so this package resolves escalations through
 * `ctx.approval` without importing the approval or agent packages (the tool
 * layer infers `A`/`C` as its own `Agent`/`CallId`).
 */
export interface EscalationApprover<A = object, C = string> {
  /**
   * Ask the human to approve one action, resolving to a closed outcome.
   * @param req - the audit-self-contained request (agent, tool, call id, reason, optional signal).
   * @returns the human's decision as a closed {@link EscalationOutcome}.
   */
  request(req: { agent: A; toolName: string; callId: C; reason: string; signal?: AbortSignal }): Promise<EscalationOutcome>
}

/**
 * The approval ingredients an escalating tool hands {@link approveEscalation}:
 * the approval requester (`ctx.approval`, or `undefined` when none is
 * composed), the calling agent (or `undefined` for an agent-less execution),
 * and the call's identity. The tool layer holds all of these; this package
 * only judges them.
 */
export interface EscalationApproval<A = object, C = string> {
  /** The approval requester (`ctx.approval`), or `undefined` when none is composed. */
  approver: EscalationApprover<A, C> | undefined
  /** The calling agent, or `undefined` for an agent-less execution (fails closed). */
  agent: A | undefined
  /** The tool-call id the approval prompt attaches to. */
  callId: C
  /** The tool name recorded on the approval request. */
  toolName: string
  /** The tool-execution abort signal the approval request rides, when present. */
  signal?: AbortSignal
}

/** One escalation request, as {@link approveEscalation} judges it. */
export interface EscalationRequest {
  /** The requested target mode (schema-pinned to {@link ESCALATION_TARGETS} when advertised). */
  requestedMode: string
  /** The model's one-sentence reason, shown verbatim to the user inside the audit reason. */
  justification: string
  /**
   * The call's effective mode (session override ?? composition default) that
   * the request is judged against. Only a request strictly wider than it goes
   * through approval; an equal or narrower request is a strict-schema
   * redundant field normalized to this mode with no approval and no error.
   */
  effectiveMode: SandboxMode
  /** The family's noun for the escalated action in user-facing texts (`command` for bash, `operation` for fs). */
  subject: string
}

/**
 * Resolve a sandbox-escalation request BEFORE anything executes. A requested
 * mode NOT strictly wider than the call's effective mode (equal or narrower)
 * is treated as a strict-schema redundant field: the call runs under the
 * effective mode with NO approval and NO error — the escalation fields are
 * optional schema keys a strict-filling model may populate with the standing
 * mode, and that must not turn into a failing call or an approval prompt.
 * Only a strictly wider request resolves the approval channel, then maps every
 * outcome — the ordered sequence both enforcing families share. Returns the
 * granted mode to stamp onto exactly this call; every failure path throws a
 * {@link HarnessError} with a stable {@link ESCALATION_ERROR_CODES} code (a
 * missing approval service, an agent-less execution, a rejection, a policy
 * block, a cancellation, an unanswerable ask) — the tool registry turns the
 * throw into the call's isError result, and nothing has run.
 * @param request - the escalation to judge (see {@link EscalationRequest}).
 * @param approval - the approval ingredients the tool holds (see {@link EscalationApproval}).
 * @returns the mode to stamp onto the call: the granted strictly-wider mode,
 *   or the effective mode when the request was a redundant (non-widening) field.
 */
export async function approveEscalation<A, C>(request: EscalationRequest, approval: EscalationApproval<A, C>): Promise<SandboxMode> {
  const { requestedMode: mode, effectiveMode, justification, subject } = request
  // Strict widening is an EXECUTION check against the call's effective mode —
  // deliberately not a schema constraint (the enum is the closed target
  // vocabulary; the effective mode is per-call truth). A request that cannot
  // strictly widen is a redundant field, never a prompt and never an error.
  if (!(WIDER_MODES[effectiveMode] ?? []).includes(mode as SandboxMode)) {
    return effectiveMode
  }
  if (approval.approver === undefined) {
    throw escalationError(ESCALATION_ERROR_CODES.unavailable, `sandbox escalation to "${mode}" requires approval, but no approval service is composed`)
  }
  if (approval.agent === undefined) {
    throw escalationError(ESCALATION_ERROR_CODES.unavailable, `sandbox escalation to "${mode}" requires approval, but the call has no agent to route it through`)
  }
  // Self-contained for the audit trail: approval/asked stores this reason,
  // and the target mode is part of the grant's identity.
  const outcome = await approval.approver.request({
    agent: approval.agent,
    toolName: approval.toolName,
    callId: approval.callId,
    reason: `escalate sandbox to ${mode}: ${justification}`,
    ...approval.signal ? { signal: approval.signal } : {},
  })
  switch (outcome) {
    // The schema enum already pinned `mode` to the closed target vocabulary;
    // the check above proved it is strictly wider.
    case 'allowed-once': return mode as SandboxMode
    case 'rejected': throw escalationError(ESCALATION_ERROR_CODES.rejected, `the user rejected escalating this ${subject} to "${mode}"`)
    case 'blocked': throw escalationError(ESCALATION_ERROR_CODES.blocked, `sandbox escalation to "${mode}" is blocked by the current approval policy`)
    case 'cancelled': throw escalationError(ESCALATION_ERROR_CODES.cancelled, `approval for escalating to "${mode}" was cancelled`)
    case 'unavailable': throw escalationError(ESCALATION_ERROR_CODES.unavailable, `sandbox escalation to "${mode}" requires approval, but no approval channel is available`)
    default: return assertNever(outcome, 'EscalationOutcome')
  }
}
