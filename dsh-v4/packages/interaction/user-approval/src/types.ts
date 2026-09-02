/**
 * Wire-safe approval identifiers and outcome vocabulary, free of
 * cordis/service imports so browser type chains (apiproxy api → client) can
 * consume them without loading this package's Context augmentation.
 * @module @deepseek-ai/dsh-user-approval/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/**
 * Pairs one `approval/asked` audit event with its `approval/decided`.
 * Service-issued (one fresh id per {@link ApprovalService.request} call).
 */
export type ApprovalRequestId = Branded<'ApprovalRequestId'>

/**
 * Brand a string as an {@link ApprovalRequestId}.
 * @param id - the raw id string to brand.
 * @returns the same string carrying the brand.
 */
export function ApprovalRequestId(id: string): ApprovalRequestId {
  return id as ApprovalRequestId
}

/**
 * Closed approval outcomes: a one-shot grant, explicit rejection, policy
 * blocking, withdrawn request, or unavailable answerer. Callers fail closed on
 * `blocked` and `unavailable`; `blocked` specifically means a deterministic
 * policy decision (e.g. the `'never'` policy) rather than a human or answerer
 * rejection.
 */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'blocked' | 'cancelled' | 'unavailable'
