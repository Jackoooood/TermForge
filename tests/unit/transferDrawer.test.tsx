import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TransferDrawer } from '@renderer/features/transfers/TransferDrawer'
import { useTransferStore } from '@renderer/stores/transferStore'
import { fakeTransferTask } from './helpers/fakeBridge'

const TRANSFERRING = fakeTransferTask({
  id: 'transfer-active',
  fileName: 'backup.bin',
  status: 'transferring',
  totalBytes: null,
  transferredBytes: 2_048,
  progress: null,
  revision: 3,
})

const FAILED = fakeTransferTask({
  id: 'transfer-failed',
  fileName: 'failed.txt',
  status: 'failed',
  errorCode: 'connection-lost',
  errorMessage: 'SSH 会话已断开，传输已停止。',
  revision: 3,
})

const CONFLICT = fakeTransferTask({
  id: 'transfer-conflict',
  fileName: 'notes.txt',
  status: 'waitingForConflictResolution',
  revision: 3,
  conflict: {
    targetPath: '/home/deploy/notes.txt',
    suggestedName: 'notes (1).txt',
    suggestedPath: '/home/deploy/notes (1).txt',
  },
})

describe('TransferDrawer', () => {
  beforeEach(() => {
    useTransferStore.getState().reset()
  })

  it('renders indeterminate progress and resolves a conflict explicitly', async () => {
    const user = userEvent.setup()
    const resolveTaskConflict = vi.fn(async () => ({
      ok: true as const,
      value: CONFLICT,
    }))
    useTransferStore.setState({
      panelOpen: true,
      tasks: [TRANSFERRING, CONFLICT],
      resolveTaskConflict,
    })

    render(<TransferDrawer />)

    const progress = screen.getByRole('progressbar', { name: 'backup.bin 传输进度' })
    expect(progress).not.toHaveAttribute('aria-valuenow')
    expect(screen.getByText(/大小未知/)).toBeInTheDocument()
    expect(screen.getByText(/进度未知/)).toBeInTheDocument()

    const group = screen.getByRole('group', { name: '处理文件冲突' })
    const nameInput = within(group).getByLabelText('重命名后的文件名')
    expect(nameInput).toHaveValue('notes (1).txt')

    await user.clear(nameInput)
    await user.type(nameInput, '..')
    await user.click(within(group).getByRole('button', { name: '重命名' }))
    expect(resolveTaskConflict).not.toHaveBeenCalled()
    expect(within(group).getByRole('alert')).toBeInTheDocument()

    await user.clear(nameInput)
    await user.type(nameInput, 'notes-copy.txt')
    await user.click(within(group).getByRole('button', { name: '覆盖' }))
    expect(resolveTaskConflict).toHaveBeenCalledWith('transfer-conflict', 'overwrite', undefined)
  })

  it('shows journal-recovered tasks as interrupted without offering a retry', () => {
    useTransferStore.setState({
      panelOpen: true,
      tasks: [
        fakeTransferTask({
          id: 'transfer-interrupted',
          fileName: 'unfinished.bin',
          status: 'interrupted',
          errorCode: 'outcome-unknown',
          errorMessage: '上次应用退出时该任务尚未完成，服务器上的实际状态未知。',
          transferredBytes: 128,
          progress: 25,
        }),
      ],
    })

    render(<TransferDrawer />)

    expect(screen.getByText('已中断')).toBeInTheDocument()
    expect(screen.getByText(/服务器上的实际状态未知/)).toBeInTheDocument()
    expect(screen.getByText(/结果未知/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '重试' })).not.toBeInTheDocument()
    expect(screen.getByText(/标记为「已中断」/)).toBeInTheDocument()
  })

  it('cancels, retries and clears ended transfers through the projection store', async () => {
    const user = userEvent.setup()
    const cancelTask = vi.fn(async () => ({ ok: true as const, value: TRANSFERRING }))
    const retryTask = vi.fn(async () => ({ ok: true as const, value: FAILED }))
    const clearHistory = vi.fn(async () => ({ ok: true as const, value: { cleared: 1 } }))
    useTransferStore.setState({
      panelOpen: true,
      tasks: [TRANSFERRING, FAILED],
      cancelTask,
      retryTask,
      clearHistory,
    })

    render(<TransferDrawer />)

    expect(screen.getByText(/SSH 会话已断开，传输已停止。/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(cancelTask).toHaveBeenCalledWith('transfer-active')

    await user.click(screen.getByRole('button', { name: '重试' }))
    expect(retryTask).toHaveBeenCalledWith('transfer-failed')

    await user.click(screen.getByRole('button', { name: '清空已结束' }))
    expect(clearHistory).toHaveBeenCalledTimes(1)
  })
})
