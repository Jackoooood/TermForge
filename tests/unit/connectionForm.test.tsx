import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MAX_JUMP_HOPS } from '@shared/constants/app'
import type {
  ConnectionGroup,
  ConnectionInput,
  ConnectionProfile,
  ConnectionTag,
} from '@shared/types'
import { ConnectionForm } from '@renderer/features/connections/ConnectionForm'

const GROUPS: ConnectionGroup[] = [
  { id: 'production', name: '生产环境', tone: 'production', sortOrder: 1 },
  { id: 'testing', name: '测试环境', tone: 'testing', sortOrder: 2 },
]

const TAGS: ConnectionTag[] = [
  { id: 'tag-api', name: 'api', color: 'cyan' },
  { id: 'tag-node', name: 'node', color: 'green' },
]

function profile(overrides: Partial<ConnectionProfile> = {}): ConnectionProfile {
  return {
    id: 'conn-bastion-1',
    name: 'bastion-1',
    host: '10.20.0.9',
    port: 22,
    username: 'jump',
    authMethod: 'password',
    groupId: 'production',
    tagIds: [],
    jumpConnectionIds: [],
    favorite: false,
    createdAt: '2026-10-22T08:00:00.000Z',
    updatedAt: '2026-10-22T08:00:00.000Z',
    ...overrides,
  }
}

function renderForm(
  onSubmit = vi.fn<(input: ConnectionInput) => Promise<void>>(),
  connections: ConnectionProfile[] = [],
) {
  render(
    <ConnectionForm
      formId="test-connection-form"
      mode="create"
      groups={GROUPS}
      tags={TAGS}
      connections={connections}
      onSubmit={onSubmit}
      onCancel={vi.fn()}
    />,
  )
  return { onSubmit }
}

describe('ConnectionForm validation', () => {
  it('shows required errors and does not submit an empty form', async () => {
    const user = userEvent.setup()
    const { onSubmit } = renderForm()

    await user.click(screen.getByRole('button', { name: '创建连接' }))

    expect(await screen.findByText('请输入连接名称')).toBeInTheDocument()
    expect(screen.getByText('请输入主机地址')).toBeInTheDocument()
    expect(screen.getByText('请输入用户名')).toBeInTheDocument()
    expect(screen.getByText('无法保存连接，请检查标出的字段。')).toBeInTheDocument()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('rejects an invalid host and an out-of-range port', async () => {
    const user = userEvent.setup()
    const { onSubmit } = renderForm()

    await user.type(screen.getByLabelText(/连接名称/), 'bad-input')
    await user.type(screen.getByLabelText(/主机/), 'https://not a host')
    await user.clear(screen.getByLabelText(/端口/))
    await user.type(screen.getByLabelText(/端口/), '70000')
    await user.type(screen.getByLabelText(/用户名/), 'root')
    await user.click(screen.getByRole('button', { name: '创建连接' }))

    expect(await screen.findByText(/请输入有效的主机名或 IP 地址/)).toBeInTheDocument()
    expect(screen.getByText(/端口范围为 1–65535/)).toBeInTheDocument()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('submits parsed values for a valid connection', async () => {
    const user = userEvent.setup()
    const { onSubmit } = renderForm()

    await user.type(screen.getByLabelText(/连接名称/), 'stage-api-02')
    await user.type(screen.getByLabelText(/主机/), '10.30.8.16')
    await user.clear(screen.getByLabelText(/端口/))
    await user.type(screen.getByLabelText(/端口/), '2222')
    await user.type(screen.getByLabelText(/用户名/), 'ubuntu')
    await user.selectOptions(screen.getByLabelText(/分组/), 'testing')
    await user.click(screen.getByLabelText('api'))
    await user.click(screen.getByLabelText('node'))
    await user.click(screen.getByRole('button', { name: '创建连接' }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
      name: 'stage-api-02',
      host: '10.30.8.16',
      port: 2222,
      username: 'ubuntu',
      groupId: 'testing',
      tagIds: ['tag-api', 'tag-node'],
      authMethod: 'password',
      credentialRef: undefined,
    })
  })

  it('submits null for an ungrouped connection without requiring a group', async () => {
    const user = userEvent.setup()
    const { onSubmit } = renderForm()

    await user.type(screen.getByLabelText(/连接名称/), 'standalone')
    await user.type(screen.getByLabelText(/主机/), '192.0.2.10')
    await user.type(screen.getByLabelText(/用户名/), 'deploy')
    await user.selectOptions(screen.getByLabelText(/分组/), '')
    await user.click(screen.getByRole('button', { name: '创建连接' }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
      name: 'standalone',
      groupId: null,
      tagIds: [],
    })
  })

  it('shows a persistence failure returned by submit and allows retrying', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn().mockRejectedValue(new Error('无法保存本地连接配置。'))
    renderForm(onSubmit)

    await user.type(screen.getByLabelText(/连接名称/), 'stage-api-02')
    await user.type(screen.getByLabelText(/主机/), '10.30.8.16')
    await user.type(screen.getByLabelText(/用户名/), 'ubuntu')
    await user.selectOptions(screen.getByLabelText(/分组/), 'testing')
    await user.click(screen.getByRole('button', { name: '创建连接' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('无法保存本地连接配置。')
    expect(screen.getByRole('button', { name: '创建连接' })).not.toBeDisabled()

    await user.click(screen.getByRole('button', { name: '创建连接' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2))
  })

  it('reveals the credential reference field for private key auth without asking for a secret', async () => {
    const user = userEvent.setup()
    renderForm()

    await user.selectOptions(screen.getByLabelText(/认证方式/), 'privateKey')

    expect(screen.getByLabelText('私钥路径或凭据引用')).toBeInTheDocument()
    expect(screen.queryByLabelText(/密码/)).not.toBeInTheDocument()
    expect(screen.getAllByText(/由主进程读取/).length).toBeGreaterThan(0)
  })
})

describe('ConnectionForm jump hosts', () => {
  it('adds, reorders and removes jump hosts and submits the ordered list', async () => {
    const user = userEvent.setup()
    const connections = [
      profile({ id: 'conn-bastion-1', name: 'bastion-1' }),
      profile({ id: 'conn-bastion-2', name: 'bastion-2', host: '10.20.0.10' }),
    ]
    const { onSubmit } = renderForm(undefined, connections)

    await user.click(screen.getByRole('button', { name: /高级选项/ }))
    expect(screen.getByText('未配置跳板：将直接连接目标服务器。')).toBeInTheDocument()

    await user.selectOptions(screen.getByLabelText('选择要添加的跳板连接'), 'conn-bastion-1')
    await user.click(screen.getByRole('button', { name: '添加' }))
    await user.selectOptions(screen.getByLabelText('选择要添加的跳板连接'), 'conn-bastion-2')
    await user.click(screen.getByRole('button', { name: '添加' }))

    const list = screen.getByRole('list', { name: '跳板连接顺序' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(2)
    expect(
      screen.getByText('连接路径：本机 → bastion-1 → bastion-2 → 目标服务器'),
    ).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '将跳板 bastion-2 上移' }))
    expect(
      screen.getByText('连接路径：本机 → bastion-2 → bastion-1 → 目标服务器'),
    ).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '移除跳板 bastion-1' }))
    expect(screen.getByText('连接路径：本机 → bastion-2 → 目标服务器')).toBeInTheDocument()

    await user.type(screen.getByLabelText(/连接名称/), 'stage-api-03')
    await user.type(screen.getByLabelText(/主机/), '10.30.8.17')
    await user.type(screen.getByLabelText(/用户名/), 'ubuntu')
    await user.click(screen.getByRole('button', { name: '创建连接' }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({ jumpConnectionIds: ['conn-bastion-2'] })
  })

  it('excludes the edited connection itself from the jump candidates', async () => {
    const user = userEvent.setup()
    const editing = profile({ id: 'conn-bastion-1', name: 'bastion-1' })
    const other = profile({ id: 'conn-bastion-2', name: 'bastion-2' })
    render(
      <ConnectionForm
        formId="edit-connection-form"
        mode="edit"
        connection={editing}
        groups={GROUPS}
        tags={TAGS}
        connections={[editing, other]}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    )

    await user.click(screen.getByRole('button', { name: /高级选项/ }))
    const select = screen.getByLabelText('选择要添加的跳板连接')
    const options = within(select)
      .getAllByRole('option')
      .map((option) => option.textContent ?? '')
    expect(options.some((text) => text.includes('bastion-1'))).toBe(false)
    expect(options.some((text) => text.includes('bastion-2'))).toBe(true)
  })

  it('stops offering jump candidates once the chain reaches the hop limit', async () => {
    const user = userEvent.setup()
    const connections = Array.from({ length: MAX_JUMP_HOPS + 1 }, (_, index) =>
      profile({ id: `conn-hop-${index}`, name: `hop-${index}` }),
    )
    renderForm(undefined, connections)

    await user.click(screen.getByRole('button', { name: /高级选项/ }))
    for (let index = 0; index < MAX_JUMP_HOPS; index += 1) {
      await user.selectOptions(screen.getByLabelText('选择要添加的跳板连接'), `conn-hop-${index}`)
      await user.click(screen.getByRole('button', { name: '添加' }))
    }

    const list = screen.getByRole('list', { name: '跳板连接顺序' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(MAX_JUMP_HOPS)
    expect(screen.getByLabelText('选择要添加的跳板连接')).toBeDisabled()
    expect(screen.getByRole('button', { name: '添加' })).toBeDisabled()
    expect(screen.getByText(new RegExp(`最多 ${MAX_JUMP_HOPS} 个`))).toBeInTheDocument()
  })
})
