// @vitest-environment jsdom
// Tool presentation branch tails not reached by the main acceptance specs.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import type { RunningToolCall, SessionId, SessionListState, ToolResultNode } from '@deepseek-ai/dsh-client-runtime/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { GenericToolCard, type GenericToolCardProps } from '../src/client/tool/toolviews/GenericToolCard.tsx'
import { ToolRow } from '../src/client/tool/components/ToolRow.tsx'
import { BashRow } from '../src/client/tool/toolviews/bash-sample.tsx'
import { zh } from '@deepseek-ai/dsh-client-ui-conversation/src/client/locales.ts'

type BashRowProps = Parameters<typeof BashRow>[0]

// Mirrors the real lookup chain (conversation namespace, then common).
const t: GenericToolCardProps['t'] = makeTranslate(zh, commonZh)

afterEach(cleanup)

const SID = 'root-1' as SessionId

function listStore() {
  return createSnapshotStore<SessionListState>({
    ids: [SID],
    byId: {
      [SID]: { id: SID, title: 'r', displayTitle: 'r', running: false, blank: false, updatedAt: 0 },
    },
    current: undefined,
    phase: 'ready',
    subagentsByParent: {}, jobsBySession: {},
    currentAddress: undefined,
  })
}

function bashProps(block: RunningToolCall | ToolResultNode): BashRowProps {
  return {
    callId: 'c1', toolName: 'bash', block, openFile: vi.fn(),
    sessionId: SID, useSessions: bindSnapshotSelector(listStore()),
    t,
  } as unknown as BashRowProps
}

describe('Tool presentation tails', () => {
  it('ToolRow stopped state renders the warning dot in the leading slot', () => {
    const view = render(
      <ToolRow t={t} variant="bash" icon={<i data-testid="icon" />} title="Bash" summary="s" body={null} state="stopped" />,
    )
    expect(view.queryByTestId('icon')).toBeNull()
    expect(view.container.querySelector('[data-state="stopped"]')).not.toBeNull()
  })

  it('ToolRow blocked state renders the warning dot, not the red error dot', () => {
    const view = render(
      <ToolRow t={t} variant="bash" icon={<i data-testid="icon" />} title="Bash" summary="s" body={null} state="blocked" />,
    )
    expect(view.queryByTestId('icon')).toBeNull()
    expect(view.container.querySelector('[data-state="blocked"]')).not.toBeNull()
    expect(view.container.querySelector('[data-state="error"]')).toBeNull()
  })

  it('a settled others-variant row renders the sparkle icon in the leading slot', () => {
    const settled: ToolResultNode = {
      kind: 'tool-result', seq: 2, time: 2_000, callId: 'c5',
      call: { name: 'todo_write', argsRaw: '{"note":"x"}' },
      callTime: 1_000,
      content: [], isError: false, callView: null, resultView: null, subCalls: [],
    }
    const props: GenericToolCardProps = {
      callId: 'c5', toolName: 'todo_write', block: settled, openFile: vi.fn(), t,
    }
    const view = render(<GenericToolCard {...props} />)
    expect(view.container.querySelector('[data-variant="others"] svg')).not.toBeNull()
    expect(view.container.querySelector('[data-state="ok"]')).not.toBeNull()
  })

  it('BashRow summarizes the description without a row click target', () => {
    const settled: ToolResultNode = {
      kind: 'tool-result', seq: 3, time: 3_000, callId: 'c1',
      call: { name: 'bash', argsRaw: '{"command":"make build","description":"Build"}' },
      callTime: 2_000,
      content: [], isError: false, callView: null, resultView: null, subCalls: [],
    }
    const view = render(<BashRow {...bashProps(settled)} />)
    const row = view.container.querySelector('[data-sample="bash"]')!
    expect(row.textContent).toContain('Bash')
    expect(row.textContent).toContain('Build')
    expect(row.getAttribute('data-clickable')).toBeNull()
  })

  it('BashRow carries data-state for running and StateDots for error/stopped', () => {
    const running: RunningToolCall = {
      callId: 'c1', name: 'bash', argsRaw: '{"command":"ls","description":"List"}',
      turn: 1, step: 1, time: 1_000, callView: null, subCalls: [],
    }
    const errorResult: ToolResultNode = {
      kind: 'tool-result', seq: 1, time: 1_000, callId: 'c1',
      call: { name: 'bash', argsRaw: '{"command":"boom"}' },
      callTime: 500,
      content: [], isError: true, callView: null, resultView: null, subCalls: [],
    }
    const stoppedResult: ToolResultNode = {
      ...errorResult,
      error: { name: 'E', code: 'interrupted' },
    }

    const runningView = render(<BashRow {...bashProps(running)} />)
    expect(runningView.container.querySelector('[data-state="running"]')).not.toBeNull()
    expect(runningView.getByText('Bash')).toBeTruthy()
    expect(runningView.getByText('List')).toBeTruthy()
    runningView.unmount()

    const errorView = render(<BashRow {...bashProps(errorResult)} />)
    expect(errorView.container.querySelector('[data-sample="bash"]')).not.toBeNull()
    expect(errorView.container.querySelector('[data-state="error"]')).not.toBeNull()
    expect(errorView.getByText('失败')).toBeTruthy()
    errorView.unmount()

    const stoppedView = render(<BashRow {...bashProps(stoppedResult)} />)
    expect(stoppedView.container.querySelector('[data-state="stopped"]')).not.toBeNull()
    expect(stoppedView.getByText('已停止')).toBeTruthy()
  })

  it('BashRow renders a blocked denial non-red and only errors mark the OUT text red', () => {
    const blockedResult: ToolResultNode = {
      kind: 'tool-result', seq: 1, time: 1_000, callId: 'c1',
      call: { name: 'bash', argsRaw: '{"command":"rm -rf /"}' },
      callTime: 500,
      content: [{ type: 'text', text: 'Error: bash is disabled by policy' }],
      isError: true, error: { name: 'E', code: 'TOOL_POLICY_DENIED' },
      callView: null, resultView: null, subCalls: [],
    }
    // The OUT text span inside the expanded IO card (the section whose gutter
    // label is `OUT`).
    const outTextOf = (container: HTMLElement): Element | undefined => {
      const label = [...container.querySelectorAll('span')].find(span => span.textContent === 'OUT')
      return label?.parentElement?.querySelectorAll('span')[1]
    }

    const blockedView = render(<BashRow {...bashProps(blockedResult)} />)
    const row = blockedView.container.querySelector('[data-sample="bash"]')!
    expect(row.getAttribute('data-state')).toBe('blocked')
    expect(blockedView.container.querySelector('[data-state="warning"]')).not.toBeNull()
    // Collapsed summary: the denial line with the `Error: ` envelope dropped.
    expect(row.textContent).toContain('bash is disabled by policy')
    expect(row.textContent).not.toContain('Error: bash is disabled by policy')
    fireEvent.click(row)
    expect(outTextOf(blockedView.container)?.getAttribute('data-error')).toBeNull()
    blockedView.unmount()

    const errorResult: ToolResultNode = {
      ...blockedResult,
      error: { name: 'E', code: 'PLUGIN_ONLY_CODE' },
    }
    const errorView = render(<BashRow {...bashProps(errorResult)} />)
    const errorRow = errorView.container.querySelector('[data-sample="bash"]')!
    expect(errorRow.getAttribute('data-state')).toBe('error')
    fireEvent.click(errorRow)
    // A real failure keeps both the red OUT marker and the `Error: ` envelope.
    expect(outTextOf(errorView.container)?.getAttribute('data-error')).toBe('true')
    expect(errorRow.textContent).toContain('Error: bash is disabled by policy')
  })

  it('BashRow keeps a stopped call with durable output expandable, warning-styled and never red', () => {
    const stoppedResult: ToolResultNode = {
      kind: 'tool-result', seq: 1, time: 1_000, callId: 'c1',
      call: { name: 'bash', argsRaw: '{"command":"sleep 60","description":"Wait"}' },
      callTime: 500,
      content: [{ type: 'text', text: 'Error: tool call aborted' }],
      isError: true, error: { name: 'AbortError', code: 'ABORTED' },
      callView: null, resultView: null, subCalls: [],
    }
    const outTextOf = (container: HTMLElement): Element | undefined => {
      const label = [...container.querySelectorAll('span')].find(span => span.textContent === 'OUT')
      return label?.parentElement?.querySelectorAll('span')[1]
    }

    const view = render(<BashRow {...bashProps(stoppedResult)} />)
    const row = view.container.querySelector('[data-sample="bash"]')!
    expect(row.getAttribute('data-state')).toBe('stopped')
    expect(row.getAttribute('data-expandable')).not.toBeNull()
    expect(row.getAttribute('role')).toBe('button')
    expect(view.container.querySelector('[data-state="warning"]')).not.toBeNull()
    // The collapsed summary surfaces the stopped outcome before the full output.
    expect(row.textContent).toContain('Error: tool call aborted')
    fireEvent.click(row)
    expect(row.getAttribute('aria-expanded')).toBe('true')
    const out = outTextOf(view.container)
    expect(out?.textContent).toBe('Error: tool call aborted')
    expect(out?.getAttribute('data-error')).toBeNull()
  })
})
