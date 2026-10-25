import { useState } from 'react'
import { Info, Trash2 } from 'lucide-react'
import type { PortForwardItem } from '@shared/types'
import { Button } from '@renderer/components/common/Button'
import { Modal } from '@renderer/components/common/Modal'
import { useAppStore } from '@renderer/stores/appStore'
import { usePortForwardStore } from '@renderer/stores/portForwardStore'

export function DeletePortForwardModal() {
  const targetId = usePortForwardStore((state) => state.deleteTargetId)
  const items = usePortForwardStore((state) => state.items)
  const cancelDelete = usePortForwardStore((state) => state.cancelDelete)

  const item = targetId ? items.find((entry) => entry.rule.id === targetId) : undefined
  if (!item) return null

  return <DeleteDialog key={item.rule.id} item={item} onClose={cancelDelete} />
}

function DeleteDialog({ item, onClose }: { item: PortForwardItem; onClose: () => void }) {
  const removeRule = usePortForwardStore((state) => state.removeRule)
  const pending = usePortForwardStore((state) => state.pending[item.rule.id])
  const pushToast = useAppStore((state) => state.pushToast)
  const [error, setError] = useState<string | null>(null)
  const deleting = pending === 'remove'

  const handleDelete = async (): Promise<void> => {
    if (deleting) return
    setError(null)
    try {
      await removeRule(item.rule.id)
      pushToast({
        tone: 'success',
        title: '转发规则已删除',
        description: `${item.rule.name} 已从本机配置中移除。`,
      })
    } catch (caught) {
      setError(
        caught instanceof Error && caught.message
          ? caught.message
          : '转发规则删除失败，请稍后重试。',
      )
    }
  }

  return (
    <Modal
      title="删除转发规则？"
      description="此操作只删除本机保存的规则；不会修改远端服务器上的任何文件。"
      width={470}
      onClose={onClose}
      footer={
        <>
          <Button variant="danger" disabled={deleting} onClick={() => void handleDelete()}>
            <Trash2 size={13} aria-hidden="true" />
            {deleting ? '删除中…' : '删除规则'}
          </Button>
          <Button variant="ghost" disabled={deleting} onClick={onClose}>
            取消
          </Button>
        </>
      }
    >
      <div className="delete-confirm">
        <div className="delete-confirm__target">
          <span className="delete-confirm__icon" aria-hidden="true">
            <Trash2 size={16} />
          </span>
          <div>
            <p className="delete-confirm__name">{item.rule.name}</p>
            <p className="delete-confirm__address">
              {item.rule.type === 'dynamic'
                ? `SOCKS5 127.0.0.1:${item.rule.bindPort}`
                : `${item.rule.bindAddress}:${item.rule.bindPort} → ${item.rule.targetHost}:${item.rule.targetPort}`}
            </p>
          </div>
        </div>

        <p className="delete-confirm__message">
          删除后该规则及其运行时状态会从本机移除；运行中的规则需要先停止并完成清理后才能删除。
        </p>

        {error ? (
          <div className="form-error-summary" role="alert">
            <Info size={13} aria-hidden="true" />
            <span>{error}</span>
          </div>
        ) : null}

        <div className="delete-confirm__note">
          <Info size={13} aria-hidden="true" />
          <span>不会向远端服务器发送请求，也不会读取或记录任何转发数据。</span>
        </div>
      </div>
    </Modal>
  )
}
