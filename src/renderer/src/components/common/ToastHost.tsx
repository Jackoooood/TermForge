import { useEffect } from 'react'
import type { LucideIcon } from 'lucide-react'
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react'
import { createPortal } from 'react-dom'
import { useAppStore } from '@renderer/stores/appStore'
import type { ToastMessage, ToastTone } from '@renderer/stores/appStore'

const TOAST_ICONS: Record<ToastTone, LucideIcon> = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  danger: XCircle,
}

function ToastItem({ toast, onDismiss }: { toast: ToastMessage; onDismiss: (id: number) => void }) {
  const Icon = TOAST_ICONS[toast.tone]

  useEffect(() => {
    const timer = window.setTimeout(() => onDismiss(toast.id), 5200)
    return () => window.clearTimeout(timer)
  }, [toast.id, onDismiss])

  return (
    <div className={`toast toast--${toast.tone}`}>
      <Icon className="toast__icon" size={16} aria-hidden="true" />
      <div className="toast__body">
        <p className="toast__title">{toast.title}</p>
        {toast.description ? <p className="toast__description">{toast.description}</p> : null}
      </div>
      <button
        type="button"
        className="toast__close"
        aria-label="关闭通知"
        title="关闭通知"
        onClick={() => onDismiss(toast.id)}
      >
        <X size={13} aria-hidden="true" />
      </button>
    </div>
  )
}

export function ToastHost() {
  const toasts = useAppStore((state) => state.toasts)
  const dismissToast = useAppStore((state) => state.dismissToast)

  if (toasts.length === 0) return null

  return createPortal(
    <div className="toast-stack" aria-live="polite" aria-label="通知">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={dismissToast} />
      ))}
    </div>,
    document.body,
  )
}
