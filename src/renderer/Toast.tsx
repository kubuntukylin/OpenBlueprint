// Toast notification overlay — renders at bottom-right, auto-dismisses
import { useNotificationStore, type Toast } from './stores'

const COLORS: Record<Toast['type'], string> = {
  success: 'border-green-500/50 bg-green-500/10 text-green-400',
  error: 'border-red-500/50 bg-red-500/10 text-red-400',
  warning: 'border-yellow-500/50 bg-yellow-500/10 text-yellow-400',
  info: 'border-blue-500/50 bg-blue-500/10 text-blue-400',
}

const ICONS: Record<Toast['type'], string> = {
  success: '✓', error: '✕', warning: '⚠', info: 'ℹ',
}

export default function ToastContainer() {
  const toasts = useNotificationStore(s => s.toasts)
  const remove = useNotificationStore(s => s.removeToast)

  if (toasts.length === 0) return null

  return (
    <div className="fixed bottom-4 right-4 z-[9999] flex flex-col gap-2 max-w-sm pointer-events-none">
      {toasts.map(t => (
        <div key={t.id}
          className={`pointer-events-auto px-4 py-3 rounded-xl border text-sm shadow-xl backdrop-blur-sm flex items-start gap-3 animate-slideIn cursor-pointer transition-opacity hover:opacity-90 ${COLORS[t.type]}`}
          onClick={() => remove(t.id)}>
          <span className="text-base font-bold flex-shrink-0">{ICONS[t.type]}</span>
          <span className="flex-1">{t.message}</span>
          <button className="text-current opacity-50 hover:opacity-100 flex-shrink-0" onClick={e => { e.stopPropagation(); remove(t.id) }}>✕</button>
        </div>
      ))}
    </div>
  )
}
