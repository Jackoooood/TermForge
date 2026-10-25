import type { ConnectionProfile } from '@shared/types'
import { useSessionStore } from '@renderer/stores/sessionStore'
import { useWorkspaceStore } from '@renderer/stores/workspaceStore'

export async function openConnectionSession(
  connection: Pick<ConnectionProfile, 'id' | 'name'>,
): Promise<string | null> {
  useWorkspaceStore.getState().setActiveModule('workbench')
  return useSessionStore.getState().openSession(connection)
}
