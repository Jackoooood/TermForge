export const AUTH_METHODS = ['password', 'privateKey', 'sshAgent'] as const

export type AuthMethod = (typeof AUTH_METHODS)[number]

export type ConnectionGroupTone = 'neutral' | 'production' | 'testing' | 'local'

export const CONNECTION_TAG_COLORS = [
  'purple',
  'blue',
  'cyan',
  'green',
  'orange',
  'red',
  'neutral',
] as const

export type ConnectionTagColor = (typeof CONNECTION_TAG_COLORS)[number]

export interface ConnectionTag {
  id: string
  name: string
  color: ConnectionTagColor
}

export interface ConnectionGroup {
  id: string
  name: string
  tone: ConnectionGroupTone
  sortOrder: number
}

export interface ConnectionProfile {
  id: string
  name: string
  host: string
  port: number
  username: string
  authMethod: AuthMethod
  /** `null` means the connection is not assigned to a group. */
  groupId: string | null
  /** Stable references into the catalog's tag definitions. */
  tagIds: string[]
  /**
   * A non-secret pointer (for example a key path or vault item name). Password
   * and private-key material must never be stored on the profile.
   */
  credentialRef?: string
  /**
   * Ordered jump-host references (nearest hop first). Each entry is the ID of
   * another saved connection whose own auth and host-key trust are used; no
   * credentials or sockets are copied into this profile.
   */
  jumpConnectionIds: string[]
  favorite: boolean
  createdAt: string
  updatedAt: string
}

export interface ConnectionInput {
  name: string
  host: string
  port: number
  username: string
  authMethod: AuthMethod
  groupId: string | null
  tagIds: string[]
  credentialRef?: string
  jumpConnectionIds: string[]
}

export interface ConnectionCatalog {
  tags: ConnectionTag[]
  connections: ConnectionProfile[]
  groups: ConnectionGroup[]
}

export interface ConnectionGroupDraft {
  name: string
}

export interface ConnectionTagDraft {
  name: string
  color: ConnectionTagColor
}

export type ConnectionBulkAction =
  | { type: 'favorite'; favorite: boolean }
  | { type: 'set-group'; groupId: string | null }
  | { type: 'add-tags'; tagIds: string[] }
  | { type: 'remove-tags'; tagIds: string[] }

export interface ConnectionBulkFailure {
  id: string
  code: 'not-found' | 'invalid-input'
  message: string
}

export interface ConnectionBulkResult {
  updated: ConnectionProfile[]
  failures: ConnectionBulkFailure[]
}
