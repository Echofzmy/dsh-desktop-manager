/**
 * Tests for the shared escalation vocabulary and choreography: the strictly-
 * wider ladder, the argument-pairing validation, the model-facing markers, and
 * {@link approveEscalation}'s ordered fail-closed sequence. Both enforcing tool
 * families (`dsh-tool-bash`, `dsh-tool-fs`) delegate here, so the ordering and
 * verbatim texts are pinned once, next to the vocabulary that owns them.
 */

import { describe, expect, it } from 'vitest'
import {
  ESCALATION_TARGETS,
  ESCALATION_ERROR_CODES,
  WIDER_MODES,
  approveEscalation,
  escalationError,
  escalationHintMarker,
  sandboxDenialMarker,
  validateEscalationArgs,
} from '@deepseek-ai/dsh-sandbox'
import type { EscalationApprover, EscalationOutcome } from '@deepseek-ai/dsh-sandbox'

describe('the strictly-wider ladder', () => {
  it('read-only escalates to either wider mode; workspace-write only to full access', () => {
    expect(WIDER_MODES['read-only']).toEqual(['workspace-write', 'danger-full-access'])
    expect(WIDER_MODES['workspace-write']).toEqual(['danger-full-access'])
    expect(WIDER_MODES['danger-full-access']).toBeUndefined()
  })

  it('the target enum is the closed set every session could escalate TO (read-only is the floor)', () => {
    expect(ESCALATION_TARGETS).toEqual(['workspace-write', 'danger-full-access'])
  })
})

describe('validateEscalationArgs', () => {
  it('accepts neither field, or both with a non-empty justification', () => {
    expect(() => { validateEscalationArgs(undefined, undefined) }).not.toThrow()
    expect(() => { validateEscalationArgs('workspace-write', 'because the workspace needs it') }).not.toThrow()
  })

  it('rejects one field without the other, and a blank justification, each with a stable INVALID_ARGS code', () => {
    const caught = (run: () => void): unknown => {
      try { run(); return undefined } catch (error) { return error }
    }
    expect(caught(() => { validateEscalationArgs('workspace-write', undefined) }))
      .toMatchObject({ message: /requires a justification/, code: 'INVALID_ARGS' })
    expect(caught(() => { validateEscalationArgs(undefined, 'orphan reason') }))
      .toMatchObject({ message: /only valid together with sandbox_permissions/, code: 'INVALID_ARGS' })
    expect(caught(() => { validateEscalationArgs('workspace-write', '   ') }))
      .toMatchObject({ message: /non-empty sentence/, code: 'INVALID_ARGS' })
  })
})

describe('the model-facing markers', () => {
  it('the denial marker names the mode', () => {
    expect(sandboxDenialMarker('read-only')).toBe('[sandbox: file access denied under read-only mode]')
    expect(sandboxDenialMarker('workspace-write')).toBe('[sandbox: file access denied under workspace-write mode]')
  })

  it('the hint marker names the family subject', () => {
    expect(escalationHintMarker('command')).toContain('retry this exact command once with sandbox_permissions')
    expect(escalationHintMarker('operation')).toContain('retry this exact operation once with sandbox_permissions')
  })
})

describe('approveEscalation', () => {
  const req = (over: Partial<Parameters<typeof approveEscalation>[0]> = {}) => ({
    requestedMode: 'workspace-write',
    justification: 'the user asked to write in the workspace',
    effectiveMode: 'read-only' as const,
    subject: 'command',
    ...over,
  })
  /** An approver that records the request and returns a fixed outcome. */
  const approver = (outcome: EscalationOutcome, sink?: (req: unknown) => void): EscalationApprover => ({
    request: async (request) => { sink?.(request); return outcome },
  })
  const ingredients = (over: Partial<Parameters<typeof approveEscalation>[1]> = {}) => ({
    approver: approver('allowed-once'),
    agent: {},
    callId: 'call-1',
    toolName: 'bash',
    ...over,
  })

  it('grants: returns the requested mode, asking through the approver with the audit reason', async () => {
    const seen: { reason?: string }[] = []
    const granted = await approveEscalation(req(), ingredients({ approver: approver('allowed-once', r => seen.push(r as { reason?: string })) }))
    expect(granted).toBe('workspace-write')
    expect(seen[0]?.reason).toBe('escalate sandbox to workspace-write: the user asked to write in the workspace')
  })

  it.each([
    // Effective mode, requested mode, expected stamp — an equal or narrower
    // request is a strict-schema redundant field, resolved to the effective
    // mode with no approval and no error.
    ['read-only', 'read-only', 'read-only'],
    ['workspace-write', 'workspace-write', 'workspace-write'],
    ['workspace-write', 'read-only', 'workspace-write'],
    ['danger-full-access', 'danger-full-access', 'danger-full-access'],
    ['danger-full-access', 'workspace-write', 'danger-full-access'],
    ['danger-full-access', 'read-only', 'danger-full-access'],
  ] as const)('a redundant %s+%s request runs under the effective %s mode: no approval, no error', async (effective, requested, expected) => {
    const seen: unknown[] = []
    const spy = ingredients({ approver: approver('allowed-once', r => seen.push(r)) })
    const mode = await approveEscalation(req({ requestedMode: requested, effectiveMode: effective }), spy)
    expect(mode).toBe(expected)
    // A redundant field must never reach the approval channel — even a
    // strictly-wider request would only be granted via the approver.
    expect(seen).toEqual([])
  })

  it('a redundant request passes through even with NO approval service and NO agent', async () => {
    const withoutApprover = await approveEscalation(
      req({ requestedMode: 'workspace-write', effectiveMode: 'danger-full-access' as never }),
      ingredients({ approver: undefined }),
    )
    expect(withoutApprover).toBe('danger-full-access')
    const withoutAgent = await approveEscalation(
      req({ requestedMode: 'workspace-write', effectiveMode: 'workspace-write' as never }),
      ingredients({ agent: undefined }),
    )
    expect(withoutAgent).toBe('workspace-write')
  })

  it('a missing approval service and an agent-less call each fail closed with distinct text and a stable SANDBOX_ESCALATION_UNAVAILABLE code', async () => {
    await expect(approveEscalation(req(), ingredients({ approver: undefined })))
      .rejects.toMatchObject({ message: /no approval service is composed/, code: 'SANDBOX_ESCALATION_UNAVAILABLE' })
    await expect(approveEscalation(req(), ingredients({ agent: undefined })))
      .rejects.toMatchObject({ message: /no agent to route it through/, code: 'SANDBOX_ESCALATION_UNAVAILABLE' })
  })

  it('maps each non-grant outcome to its distinct verbatim text and stable code (subject in the rejection)', async () => {
    await expect(approveEscalation(req({ subject: 'operation' }), ingredients({ approver: approver('rejected') })))
      .rejects.toMatchObject({
        message: 'the user rejected escalating this operation to "workspace-write"',
        code: 'SANDBOX_ESCALATION_REJECTED',
      })
    await expect(approveEscalation(req(), ingredients({ approver: approver('blocked') })))
      .rejects.toMatchObject({
        message: 'sandbox escalation to "workspace-write" is blocked by the current approval policy',
        code: 'SANDBOX_ESCALATION_BLOCKED',
      })
    await expect(approveEscalation(req(), ingredients({ approver: approver('cancelled') })))
      .rejects.toMatchObject({
        message: 'approval for escalating to "workspace-write" was cancelled',
        code: 'SANDBOX_ESCALATION_CANCELLED',
      })
    await expect(approveEscalation(req(), ingredients({ approver: approver('unavailable') })))
      .rejects.toMatchObject({
        message: 'sandbox escalation to "workspace-write" requires approval, but no approval channel is available',
        code: 'SANDBOX_ESCALATION_UNAVAILABLE',
      })
  })

  it('the stable codes match the ESCALATION_ERROR_CODES vocabulary and the factory carries them', () => {
    expect(ESCALATION_ERROR_CODES).toEqual({
      invalidArgs: 'INVALID_ARGS',
      blocked: 'SANDBOX_ESCALATION_BLOCKED',
      rejected: 'SANDBOX_ESCALATION_REJECTED',
      cancelled: 'SANDBOX_ESCALATION_CANCELLED',
      unavailable: 'SANDBOX_ESCALATION_UNAVAILABLE',
    })
    const error = escalationError(ESCALATION_ERROR_CODES.blocked, 'blocked')
    expect(error).toMatchObject({ message: 'blocked', code: 'SANDBOX_ESCALATION_BLOCKED' })
    expect(error.name).toBe('HarnessError')
  })

  it('an outcome outside the closed union trips the exhaustiveness guard (defensive)', async () => {
    await expect(approveEscalation(req(), ingredients({ approver: approver('bogus' as never) }))).rejects.toThrow()
  })
})
