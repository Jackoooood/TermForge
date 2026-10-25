import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PrimarySidebar } from '@renderer/components/layout/PrimarySidebar'
import { useConnectionStore } from '@renderer/stores/connectionStore'
import { createFakeBridge } from './helpers/fakeBridge'

async function loadPersistedConnections(): Promise<void> {
  useConnectionStore.setState({
    connections: [],
    groups: [],
    tags: [],
    loadStatus: 'idle',
    loadError: null,
    persistenceError: null,
    searchQuery: '',
    collapsedGroupIds: [],
    editor: { open: false, mode: 'create', connectionId: null },
    deleteTargetId: null,
    deleteStatus: 'idle',
    deleteError: null,
  })
  await useConnectionStore.getState().loadConnections()
}

describe('PrimarySidebar search', () => {
  beforeEach(async () => {
    window.termforge = createFakeBridge()
    await loadPersistedConnections()
  })

  afterEach(() => {
    delete window.termforge
  })

  it('filters persisted connections by tag, address and group, then clears the query', async () => {
    const user = userEvent.setup()
    render(<PrimarySidebar />)

    expect(
      (await screen.findAllByRole('button', { name: /连接 prod-web-01/ })).length,
    ).toBeGreaterThan(0)

    const search = screen.getByRole('searchbox', { name: '搜索服务器' })
    await user.type(search, 'nginx')
    expect(screen.getAllByRole('button', { name: /连接 prod-web-01/ }).length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: /连接 prod-db-01/ })).not.toBeInTheDocument()

    await user.clear(search)
    await user.type(search, '10.20.4.21')
    expect(screen.getByRole('button', { name: /连接 prod-db-01/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /连接 prod-web-01/ })).not.toBeInTheDocument()

    await user.clear(search)
    await user.type(search, '测试环境')
    expect(screen.getByRole('button', { name: /连接 stage-api-01/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /连接 prod-cache-01/ })).not.toBeInTheDocument()

    await user.clear(search)
    await user.type(search, 'no-such-server')
    expect(screen.getByText('未找到匹配的服务器')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '清除搜索条件' }))

    expect(screen.getAllByRole('button', { name: /连接 prod-web-01/ }).length).toBeGreaterThan(0)
    expect(screen.getAllByRole('button', { name: /连接 devbox/ }).length).toBeGreaterThan(0)
    expect(search).toHaveValue('')
  })
})
