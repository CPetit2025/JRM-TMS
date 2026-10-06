"use client"
import { ReactNode, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'

interface ModalProps {
  isOpen: boolean
  onClose: () => void
  title: string
  children: ReactNode
  maxWidth?: string
  footer?: ReactNode
}

export function Modal({ isOpen, onClose, title, children, maxWidth = "max-w-lg", footer }: ModalProps) {
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
    return () => setMounted(false)
  }, [])

  // Close on ESC key
  useEffect(() => {
    if (!isOpen) return
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKey)
    // Prevent body scroll when modal is open
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', handleKey)
      document.body.style.overflow = ''
    }
  }, [isOpen, onClose])

  if (!isOpen || !mounted) return null

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center p-3 sm:p-4"
    >
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm"
        onClick={onClose}
      />
      {/* Modal panel */}
      <div
        role="dialog" aria-modal="true" aria-label={title}
        className={`relative min-w-0 bg-white rounded-2xl shadow-2xl w-full ${maxWidth} max-h-[calc(100dvh-1.5rem)] overflow-hidden flex flex-col sm:max-h-[90dvh]`}
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-2 px-4 py-3 sm:px-5 sm:py-4 border-b border-slate-100 bg-slate-50 shrink-0">
          <h2 className="min-w-0 break-words text-base font-bold text-[#002855]">{title}</h2>
          <button
            onClick={onClose}
            aria-label="Cerrar ventana"
            className="grid h-11 w-11 shrink-0 place-items-center text-slate-400 hover:text-slate-600 hover:bg-slate-200 rounded-lg transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        {/* Content */}
        <div className="min-h-0 min-w-0 p-4 overflow-auto flex-1 sm:p-6">
          {children}
        </div>
        {footer && <div className="shrink-0 border-t border-slate-200 bg-white px-4 py-3 sm:px-6">{footer}</div>}
      </div>
    </div>,
    document.body
  )
}
