import { Info, ShieldAlert, Trash2 } from 'lucide-react'
import { Button } from '@renderer/components/common/Button'
import { Modal } from '@renderer/components/common/Modal'
import { useConnectionStore } from '@renderer/stores/connectionStore'

export function DeleteConnectionModal() {
  const targetId = useConnectionStore((state) => state.deleteTargetId)
  const connections = useConnectionStore((state) => state.connections)
  const deleteStatus = useConnectionStore((state) => state.deleteStatus)
  const deleteError = useConnectionStore((state) => state.deleteError)
  const deleteImpact = useConnectionStore((state) => state.deleteImpact)
  const deleteImpactStatus = useConnectionStore((state) => state.deleteImpactStatus)
  const deleteImpactError = useConnectionStore((state) => state.deleteImpactError)
  const cascadePortForwards = useConnectionStore((state) => state.cascadePortForwards)
  const cancelDelete = useConnectionStore((state) => state.cancelDelete)
  const loadDeleteImpact = useConnectionStore((state) => state.loadDeleteImpact)
  const setCascadePortForwards = useConnectionStore(
    (state) => state.setCascadePortForwards,
  )
  const confirmDelete = useConnectionStore((state) => state.confirmDelete)

  const target = connections.find((connection) => connection.id === targetId)
  if (!target) return null

  const deleting = deleteStatus === 'deleting'
  const impactLoading = deleteImpactStatus === 'loading'
  const impactFailed = deleteImpactStatus === 'error'
  const ruleCount = deleteImpact?.portForwardRuleCount ?? 0
  const runningCount = deleteImpact?.runningPortForwardCount ?? 0
  const cascadeRequired = ruleCount > 0
  const confirmBlocked =
    deleting ||
    impactLoading ||
    impactFailed ||
    (cascadeRequired && !cascadePortForwards)

  return (
    <Modal
      title="删除连接？"
      description="此操作只影响本机连接配置。"
      width={520}
      onClose={cancelDelete}
      footer={
        <>
          <Button
            variant="danger"
            disabled={confirmBlocked}
            title={
              impactLoading
                ? '正在检查关联的端口转发规则'
                : impactFailed
                  ? '请先重试检查关联规则'
                  : cascadeRequired && !cascadePortForwards
                    ? '请先确认清理关联的端口转发规则'
                    : undefined
            }
            onClick={() => void confirmDelete()}
          >
            <Trash2 size={13} aria-hidden="true" />
            {deleting
              ? '删除中…'
              : cascadeRequired
                ? '删除连接并清理规则'
                : '删除连接'}
          </Button>
          <Button variant="ghost" disabled={deleting} onClick={cancelDelete}>
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
            <p className="delete-confirm__name">{target.name}</p>
            <p className="delete-confirm__address">
              {target.username}@{target.host}:{target.port}
            </p>
          </div>
        </div>

        <p className="delete-confirm__message">
          删除后该连接将从本地列表中移除；若相关 SSH
          会话仍处于活动状态，会先请求主进程断开。主进程会尽力删除该连接在操作系统凭据存储中的密码、私钥与口令条目；不会删除主机密钥信任记录。
        </p>

        {impactLoading ? (
          <div className="delete-confirm__note" role="status">
            <Info size={13} aria-hidden="true" />
            <span>正在检查该连接关联的端口转发规则…</span>
          </div>
        ) : null}

        {impactFailed ? (
          <div className="form-error-summary" role="alert">
            <Info size={13} aria-hidden="true" />
            <span>{deleteImpactError ?? '无法检查关联的端口转发规则。'}</span>
            <Button
              size="sm"
              variant="secondary"
              disabled={deleting}
              onClick={() => void loadDeleteImpact()}
            >
              重试检查
            </Button>
          </div>
        ) : null}

        {deleteImpactStatus === 'ready' && ruleCount === 0 ? (
          <div className="delete-confirm__note">
            <Info size={13} aria-hidden="true" />
            <span>未发现关联的端口转发规则。</span>
          </div>
        ) : null}

        {deleteImpactStatus === 'ready' && cascadeRequired ? (
          <div className="forward-exposure">
            <div className="delete-confirm__note">
              <ShieldAlert size={13} aria-hidden="true" />
              <span>
                该连接下仍有 {ruleCount} 条端口转发规则
                {runningCount > 0 ? `（其中 ${runningCount} 条运行中）` : ''}
                。删除连接前会先停止监听器、断开转发连接并删除这些规则；任一清理步骤失败都会中止删除并保留连接与规则。
              </span>
            </div>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={cascadePortForwards}
                disabled={deleting}
                onChange={(event) => setCascadePortForwards(event.target.checked)}
              />
              <span>
                我已确认停止并删除这 {ruleCount} 条端口转发规则，随后再删除该连接。
              </span>
            </label>
          </div>
        ) : null}

        {deleteError ? (
          <div className="form-error-summary" role="alert">
            <Info size={13} aria-hidden="true" />
            <span>{deleteError}</span>
          </div>
        ) : null}

        <div className="delete-confirm__note">
          <Info size={13} aria-hidden="true" />
          <span>不会向远端服务器发送请求，也不会删除服务器上的任何数据。</span>
        </div>
      </div>
    </Modal>
  )
}
