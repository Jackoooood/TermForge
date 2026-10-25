import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  SshCredentialInput,
  SshHostKeyRequestEvent,
  SshSessionSnapshot,
  SshStatusEvent,
} from '@shared/types'
import { CredentialPromptModal } from '@renderer/features/connections/CredentialPromptModal'
import { HostKeyConfirmModal } from '@renderer/features/connections/HostKeyConfirmModal'
import { useSshBridgeEvents } from '@renderer/hooks/useSshBridgeEvents'
import { useAppStore } from '@renderer/stores/appStore'
import {
  promptForCredentialIfNeeded,
  useSessionStore,
} from '@renderer/stores/sessionStore'
import { useSshPromptStore } from '@renderer/stores/sshPromptStore'
import { useTerminalStore } from '@renderer/stores/terminalStore'
import { useWorkspaceStore } from '@renderer/stores/workspaceStore'
import {
  createFakeBridge,
  fakeSessionInfo,
  fakeSshSnapshot,
} from './helpers/fakeBridge'

const TAB_ID = 'sshtab-test'

const CHALLENGE = {
  requestId: 'hk-1',
  sessionId: 'ssh-1',
  connectionId: 'conn-1',
  connectionName: 'prod',
  host: '10.20.4.11',
  port: 22,
  algorithm: 'ssh-ed25519' as const,
  fingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  expiresAt: '2026-10-22T08:00:30.000Z',
}

function resetStores(): void {
  useSshPromptStore.getState().reset()
  useSessionStore.setState({ sessions: {}, dismissedSessionIds: [] })
  useWorkspaceStore.setState({ tabOrder: [], activeTabId: null })
  useTerminalStore.getState().reset()
  useAppStore.setState({ toasts: [] })
}

function seedTab(): void {
  const tab = fakeSessionInfo({
    id: TAB_ID,
    sessionId: null,
    connectionId: 'conn-1',
    connectionName: 'prod',
    title: 'prod',
    username: 'deploy',
    status: 'connecting',
    hasTerminal: false,
    connectedAt: null,
  })
  useSessionStore.setState({ sessions: { [TAB_ID]: tab } })
  useWorkspaceStore.getState().addTab(TAB_ID)
}

function errorSnapshot(overrides: Partial<SshSessionSnapshot> = {}): SshSessionSnapshot {
  return fakeSshSnapshot({
    sessionId: 'ssh-1',
    connectionId: 'conn-1',
    connectionName: 'prod',
    status: 'error',
    connectedAt: null,
    error: {
      code: 'credential-required',
      message: '需要密码才能连接该服务器。',
      credentialKind: 'password',
    },
    ...overrides,
  })
}

describe('host key confirmation UI', () => {
  beforeEach(() => {
    resetStores()
    delete window.termforge
  })
  afterEach(() => {
    delete window.termforge
  })

  it('shows the fingerprint and submits an explicit trust decision', async () => {
    const respondToHostKey = vi.fn(async (requestId: string, accepted: boolean) => ({
      ok: true as const,
      value: { requestId, accepted },
    }))
    window.termforge = createFakeBridge({}, { respondToHostKey })
    useSshPromptStore.getState().enqueueHostKey(CHALLENGE)
    const user = userEvent.setup()
    render(<HostKeyConfirmModal />)

    expect(screen.getByText(CHALLENGE.fingerprint)).toBeInTheDocument()
    expect(screen.getByText('ssh-ed25519')).toBeInTheDocument()
    expect(screen.getAllByText(/10\.20\.4\.11:22/).length).toBeGreaterThan(0)

    await user.click(screen.getByRole('button', { name: '信任并继续' }))
    await waitFor(() => expect(useSshPromptStore.getState().hostKeyQueue).toHaveLength(0))
    expect(respondToHostKey).toHaveBeenCalledWith('hk-1', true)
  })

  it('sends an explicit rejection for the reject button, close button and Escape', async () => {
    const respondToHostKey = vi.fn(async (requestId: string, accepted: boolean) => ({
      ok: true as const,
      value: { requestId, accepted },
    }))
    window.termforge = createFakeBridge({}, { respondToHostKey })
    const user = userEvent.setup()

    useSshPromptStore.getState().enqueueHostKey(CHALLENGE)
    const { unmount } = render(<HostKeyConfirmModal />)
    await user.click(screen.getByRole('button', { name: '拒绝并断开' }))
    await waitFor(() => expect(respondToHostKey).toHaveBeenLastCalledWith('hk-1', false))
    unmount()

    useSshPromptStore.getState().enqueueHostKey({ ...CHALLENGE, requestId: 'hk-2' })
    render(<HostKeyConfirmModal />)
    await user.click(screen.getByRole('button', { name: '关闭对话框' }))
    await waitFor(() => expect(respondToHostKey).toHaveBeenLastCalledWith('hk-2', false))

    useSshPromptStore.getState().enqueueHostKey({ ...CHALLENGE, requestId: 'hk-3' })
    await user.keyboard('{Escape}')
    await waitFor(() => expect(respondToHostKey).toHaveBeenLastCalledWith('hk-3', false))
    expect(useSshPromptStore.getState().hostKeyQueue).toHaveLength(0)
  })

  it('keeps the prompt and shows the error when the trust decision was not saved', async () => {
    window.termforge = createFakeBridge({}, {
      respondToHostKey: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: 'storage-write-failed', message: '无法保存主机密钥信任决定。' },
      }),
    })
    useSshPromptStore.getState().enqueueHostKey(CHALLENGE)
    const user = userEvent.setup()
    render(<HostKeyConfirmModal />)

    await user.click(screen.getByRole('button', { name: '信任并继续' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('无法保存主机密钥信任决定。')
    expect(useSshPromptStore.getState().hostKeyQueue).toHaveLength(1)
    expect(useAppStore.getState().toasts.at(-1)?.title).toBe('主机密钥未保存')
  })
})

describe('credential prompt UI', () => {
  const SECRET = 'renderer-secret-value'

  beforeEach(() => {
    resetStores()
    delete window.termforge
  })
  afterEach(() => {
    delete window.termforge
  })

  function seedCredentialPrompt(): void {
    seedTab()
    const applied = useSessionStore.getState().applySshSnapshot(errorSnapshot())
    promptForCredentialIfNeeded(applied!)
  }

  it('sends the secret once, clears the DOM value and keeps it out of every store', async () => {
    const saveCredential = vi.fn(async (input: SshCredentialInput) => ({
      ok: true as const,
      value: { connectionId: input.connectionId, kind: input.kind },
    }))
    const connect = vi.fn(async (_connectionId: string, clientId: string) => ({
      ok: true as const,
      value: {
        session: fakeSshSnapshot({
          clientId,
          sessionId: 'ssh-2',
          connectionId: 'conn-1',
          status: 'connecting',
        }),
        reused: false,
      },
    }))
    window.termforge = createFakeBridge({}, { saveCredential, connect })
    seedCredentialPrompt()
    const user = userEvent.setup()
    render(<CredentialPromptModal />)

    const input = screen.getByPlaceholderText('输入登录密码')
    await user.type(input, SECRET)
    expect(input).toHaveValue(SECRET)

    await user.click(screen.getByRole('button', { name: '保存并重新连接' }))
    await waitFor(() =>
      expect(saveCredential).toHaveBeenCalledWith({
        connectionId: 'conn-1',
        kind: 'password',
        secret: SECRET,
      }),
    )
    await waitFor(() => expect(connect).toHaveBeenCalledWith('conn-1', TAB_ID))

    expect(useSshPromptStore.getState().credentialPrompt).toBeNull()
    expect(input).not.toBeInTheDocument()
    const persisted = JSON.stringify({
      prompt: useSshPromptStore.getState(),
      sessions: useSessionStore.getState(),
      app: useAppStore.getState(),
    })
    expect(persisted).not.toContain(SECRET)
  })

  it('keeps the prompt open on a vault failure without retrying the connection', async () => {
    const saveCredential = vi.fn().mockResolvedValue({
      ok: false,
      error: { code: 'storage-unavailable', message: '无法读取系统凭据存储。' },
    })
    const connect = vi.fn()
    window.termforge = createFakeBridge({}, { saveCredential, connect })
    seedCredentialPrompt()
    const user = userEvent.setup()
    render(<CredentialPromptModal />)

    await user.type(screen.getByPlaceholderText('输入登录密码'), SECRET)
    await user.click(screen.getByRole('button', { name: '保存并重新连接' }))

    expect(await screen.findByText('无法读取系统凭据存储。')).toBeInTheDocument()
    expect(useSshPromptStore.getState().credentialPrompt).not.toBeNull()
    expect(connect).not.toHaveBeenCalled()
    expect(JSON.stringify(useSshPromptStore.getState())).not.toContain(SECRET)
  })

  it('cancels without saving or reconnecting', async () => {
    const saveCredential = vi.fn()
    const connect = vi.fn()
    window.termforge = createFakeBridge({}, { saveCredential, connect })
    seedCredentialPrompt()
    const user = userEvent.setup()
    render(<CredentialPromptModal />)

    await user.type(screen.getByPlaceholderText('输入登录密码'), SECRET)
    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(useSshPromptStore.getState().credentialPrompt).toBeNull()
    expect(saveCredential).not.toHaveBeenCalled()
    expect(connect).not.toHaveBeenCalled()
  })
})

describe('useSshBridgeEvents', () => {
  beforeEach(() => {
    resetStores()
    delete window.termforge
  })
  afterEach(() => {
    delete window.termforge
  })

  it('mirrors pushed events and unsubscribes both listeners on unmount', async () => {
    const statusListeners: Array<(event: SshStatusEvent) => void> = []
    const hostKeyListeners: Array<(event: SshHostKeyRequestEvent) => void> = []
    const unsubscribeStatus = vi.fn()
    const unsubscribeHostKey = vi.fn()
    window.termforge = createFakeBridge({}, {
      onSessionStatus: (listener) => {
        statusListeners.push(listener)
        return unsubscribeStatus
      },
      onHostKeyRequest: (listener) => {
        hostKeyListeners.push(listener)
        return unsubscribeHostKey
      },
    })

    function Harness() {
      useSshBridgeEvents()
      return null
    }

    const { unmount } = render(<Harness />)
    expect(statusListeners).toHaveLength(1)
    expect(hostKeyListeners).toHaveLength(1)
    seedTab()

    statusListeners[0]?.({
      session: fakeSshSnapshot({ clientId: TAB_ID, sessionId: 'ssh-1', connectionId: 'conn-1', status: 'connecting' }),
    })
    expect(useSessionStore.getState().sessions[TAB_ID]?.status).toBe('connecting')

    hostKeyListeners[0]?.({ challenge: CHALLENGE })
    expect(useSshPromptStore.getState().hostKeyQueue).toHaveLength(1)

    statusListeners[0]?.({
      session: errorSnapshot(),
    })
    expect(useSessionStore.getState().sessions[TAB_ID]?.status).toBe('error')
    expect(useSshPromptStore.getState().credentialPrompt).toMatchObject({
      tabId: TAB_ID,
      sessionId: 'ssh-1',
      kind: 'password',
    })

    unmount()
    expect(unsubscribeStatus).toHaveBeenCalledTimes(1)
    expect(unsubscribeHostKey).toHaveBeenCalledTimes(1)
  })
})
