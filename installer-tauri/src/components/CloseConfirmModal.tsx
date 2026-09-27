// installer-tauri/src/components/CloseConfirmModal.tsx
// 关闭/取消操作前的二次确认弹窗

import type { StepId } from '../types'

export interface CloseConfirmModalProps {
  step: StepId
  onCancel: () => void
  onConfirm: () => void
}

export default function CloseConfirmModal({ step, onCancel, onConfirm }: CloseConfirmModalProps) {
  return (
    <div className="modal-mask" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal__title">
          {step === 'installing' ? '确定要取消操作吗？' : '确定要退出吗？'}
        </div>
        <div className="modal__desc">
          {step === 'installing'
            ? '当前操作尚未完成，取消后更改将不会应用。'
            : '你还没有完成操作，退出后将不会有任何更改。'}
        </div>
        <div className="modal__actions">
          <button className="btn" onClick={onCancel}>
            继续
          </button>
          <button className="btn btn--primary" onClick={onConfirm}>
            确定退出
          </button>
        </div>
      </div>
    </div>
  )
}
