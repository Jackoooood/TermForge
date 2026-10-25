import { useId } from 'react'
import type { ConnectionInput } from '@shared/types'
import { Modal } from '@renderer/components/common/Modal'
import { useAppStore } from '@renderer/stores/appStore'
import { useConnectionStore } from '@renderer/stores/connectionStore'
import { ConnectionForm } from './ConnectionForm'

export function ConnectionEditorModal() {
  const titleId = useId()
  const editor = useConnectionStore((state) => state.editor)
  const connections = useConnectionStore((state) => state.connections)
  const groups = useConnectionStore((state) => state.groups)
  const tags = useConnectionStore((state) => state.tags)
  const closeEditor = useConnectionStore((state) => state.closeEditor)
  const createConnection = useConnectionStore((state) => state.createConnection)
  const updateConnection = useConnectionStore((state) => state.updateConnection)
  const pushToast = useAppStore((state) => state.pushToast)

  if (!editor.open) return null

  const editingConnection =
    editor.mode === 'edit'
      ? connections.find((connection) => connection.id === editor.connectionId)
      : undefined

  if (editor.mode === 'edit' && !editingConnection) return null

  const formId = `connection-editor-${titleId.replace(/:/g, '')}`
  const mode = editor.mode
  const title = mode === 'create' ? '新建连接' : `编辑连接 · ${editingConnection?.name ?? ''}`

  const handleSubmit = async (input: ConnectionInput): Promise<void> => {
    if (mode === 'create') {
      const created = await createConnection(input)
      pushToast({
        tone: 'success',
        title: '连接已创建',
        description: `${created.name} 已保存到本机用户数据目录，不含密码或私钥。`,
      })
    } else if (editingConnection) {
      const updated = await updateConnection(editingConnection.id, input)
      pushToast({
        tone: 'success',
        title: '连接已更新',
        description: `${updated.name} 的最新配置已写入本机存储；不会连接该主机。`,
      })
    }
    closeEditor()
  }

  return (
    <Modal
      title={title}
      description="连接配置保存在本机用户数据目录，不含密码或私钥。当前版本不会建立任何网络连接。"
      width={640}
      onClose={closeEditor}
    >
      <ConnectionForm
        key={mode === 'edit' ? editingConnection?.id : 'create'}
        formId={formId}
        mode={mode}
        connection={editingConnection}
        connections={connections}
        groups={groups}
        tags={tags}
        onSubmit={handleSubmit}
        onCancel={closeEditor}
      />
    </Modal>
  )
}
