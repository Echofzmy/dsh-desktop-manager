import { describe, expect, it } from 'vitest'
import { toolOutcomeKind, type ToolOutcomeInput, type ToolOutcomeKind } from '../src/client/tool-outcome.ts'

const failed = (code: string | undefined): ToolOutcomeInput =>
  ({ isError: true, ...(code === undefined ? {} : { error: { name: 'E', code } }) })

const codes = (kind: ToolOutcomeKind): readonly string[] =>
  ['ABORTED', 'ABORTED_BEFORE_DISPATCH', 'TOOL_NOT_STARTED', 'TOOL_OUTCOME_UNKNOWN',
    'ASK_ABORTED', 'ASK_CANCELLED', 'interrupted', 'TOOL_APPROVAL_CANCELLED', 'SANDBOX_ESCALATION_CANCELLED',
    'TOOL_POLICY_DENIED', 'TOOL_APPROVAL_BLOCKED', 'TOOL_APPROVAL_REJECTED', 'TOOL_APPROVAL_UNAVAILABLE',
    'TOOL_POST_BLOCKED', 'SANDBOX_ESCALATION_BLOCKED', 'SANDBOX_ESCALATION_REJECTED',
    'SANDBOX_ESCALATION_UNAVAILABLE', 'INVALID_ARGS', 'UNKNOWN_TOOL', 'GOAL_TOOL_AGENT_REQUIRED',
    'GOAL_TOOL_DRIVER_REQUIRED', 'GOAL_TOOL_AUTHORITY_REQUIRED', 'FS_NOT_FOUND', 'FS_NOT_OBSERVED',
    'FS_STALE_VERSION', 'SEARCH_INVALID_PATTERN', 'SEARCH_RAW_OUTPUT_OVERFLOW', 'SEARCH_FAILED', 'SOME_PLUGIN_CODE']
    .filter(code => toolOutcomeKind(failed(code)) === kind)

describe('toolOutcomeKind', () => {
  it('classifies a successful call as success regardless of any error field', () => {
    expect(toolOutcomeKind({ isError: false })).toBe('success')
    expect(toolOutcomeKind({ isError: false, error: { name: 'E', code: 'ABORTED' } })).toBe('success')
  })

  it('maps cancellation and interruption codes to stopped', () => {
    expect(codes('stopped')).toEqual([
      'ABORTED', 'ABORTED_BEFORE_DISPATCH', 'TOOL_NOT_STARTED', 'TOOL_OUTCOME_UNKNOWN',
      'ASK_ABORTED', 'ASK_CANCELLED', 'interrupted', 'TOOL_APPROVAL_CANCELLED', 'SANDBOX_ESCALATION_CANCELLED',
    ])
  })

  it('maps policy, approval, sandbox, and correctable codes to blocked', () => {
    expect(codes('blocked')).toEqual([
      'TOOL_POLICY_DENIED', 'TOOL_APPROVAL_BLOCKED', 'TOOL_APPROVAL_REJECTED', 'TOOL_APPROVAL_UNAVAILABLE',
      'TOOL_POST_BLOCKED', 'SANDBOX_ESCALATION_BLOCKED', 'SANDBOX_ESCALATION_REJECTED',
      'SANDBOX_ESCALATION_UNAVAILABLE', 'INVALID_ARGS', 'UNKNOWN_TOOL', 'GOAL_TOOL_AGENT_REQUIRED',
      'GOAL_TOOL_DRIVER_REQUIRED', 'GOAL_TOOL_AUTHORITY_REQUIRED', 'FS_NOT_FOUND', 'FS_NOT_OBSERVED',
      'FS_STALE_VERSION', 'SEARCH_INVALID_PATTERN', 'SEARCH_RAW_OUTPUT_OVERFLOW',
    ])
  })

  it('keeps real filesystem and search failures as error (no FS_/SEARCH_ prefix rule)', () => {
    // Only the explicit codes above are blocked; sibling codes stay real
    // failures even though they share the FS_/SEARCH_ prefix.
    expect(toolOutcomeKind(failed('FS_PERMISSION_DENIED'))).toBe('error')
    expect(toolOutcomeKind(failed('FS_IO_ERROR'))).toBe('error')
    expect(toolOutcomeKind(failed('SEARCH_FAILED'))).toBe('error')
  })

  it('keeps unknown and uncoded failures as error', () => {
    expect(toolOutcomeKind(failed(undefined))).toBe('error')
    expect(toolOutcomeKind(failed('SOME_PLUGIN_CODE'))).toBe('error')
  })

  it('classifies every GOAL_TOOL_* code as blocked without listing each member', () => {
    expect(toolOutcomeKind(failed('GOAL_TOOL_ANY_FUTURE_CONDITION'))).toBe('blocked')
  })
})
