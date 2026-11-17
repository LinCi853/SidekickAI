/* =====================================================================
   components/SaveDialogHost.tsx —— 应用自建保存弹窗
   主进程发起保存请求时，在当前窗口弹出应用内弹窗：
   用户可改文件名、换保存目录，并可勾选“以后保存到此位置（不再询问）”。
   勾选后由主进程写回当前生效的那一层设置（AI 应用独立设置或主应用全局默认）。
   ===================================================================== */

import { useCallback, useEffect, useState } from 'react'
import type { SaveDialogReply, SaveDialogRequest } from '../../electron/shared/save-dialog.types'
import {
  markSaveDialogHostReady,
  onSaveDialogRequest,
  respondSaveDialog,
  selectDownloadDir,
} from '../lib/electron-api'
import Modal from './ui/Modal'
import Button from './ui/Button'
import './SaveDialogHost.css'

/**
 * 构造保存回执：文件名或目录为空时不生成回执（用户需要补全后才能保存）。
 * 目录与文件名的拼接、清洗由主进程完成，渲染层只负责采集用户意图。
 */
export function buildSaveReply(draft: {
  fileName: string
  directory: string
  remember: boolean
}): SaveDialogReply | null {
  const fileName = draft.fileName.trim()
  const directory = draft.directory.trim()
  if (!fileName || !directory) return null
  return { action: 'save', fileName, directory, remember: draft.remember }
}

export default function SaveDialogHost() {
  const [request, setRequest] = useState<SaveDialogRequest | null>(null)
  const [fileName, setFileName] = useState('')
  const [directory, setDirectory] = useState('')
  const [remember, setRemember] = useState(false)
  const [picking, setPicking] = useState(false)

  useEffect(() => {
    const off = onSaveDialogRequest((incoming) => {
      setRequest(incoming)
      setFileName(incoming.fileName)
      setDirectory(incoming.directory)
      setRemember(false)
    })
    // 声明本窗口已具备自建弹窗能力，主进程据此改用应用内弹窗
    void markSaveDialogHostReady().catch(() => {
      /* ignore */
    })
    return off
  }, [])

  /** 取消保存：回执 cancel，主进程据此取消本次下载 */
  const handleCancel = useCallback(() => {
    if (!request) return
    setRequest(null)
    void respondSaveDialog(request.requestId, { action: 'cancel' }).catch(() => {
      /* ignore */
    })
  }, [request])

  /** 确认保存：回执文件名与目录，"记住默认"由主进程写回对应作用域 */
  const handleConfirm = useCallback(() => {
    if (!request) return
    const reply = buildSaveReply({ fileName, directory, remember })
    if (!reply) return
    setRequest(null)
    void respondSaveDialog(request.requestId, reply).catch(() => {
      /* ignore */
    })
  }, [request, fileName, directory, remember])

  /** 更换保存目录 */
  const handlePickDirectory = useCallback(async () => {
    if (picking) return
    setPicking(true)
    try {
      const dir = await selectDownloadDir()
      if (dir) setDirectory(dir)
    } catch (err) {
      console.error('[SaveDialogHost] 选择保存目录失败:', err)
    } finally {
      setPicking(false)
    }
  }, [picking])

  return (
    <Modal
      open={!!request}
      onClose={handleCancel}
      title={request?.title ?? '另存为'}
      portal
      closeOnOverlayClick={false}
      className="save-dialog-modal"
    >
      <div className="save-dialog-body" data-name="component.save-dialog.body">
        <label className="save-dialog-label" htmlFor="save-dialog-file-name">
          文件名
        </label>
        <input
          id="save-dialog-file-name"
          className="save-dialog-input"
          type="text"
          value={fileName}
          autoFocus
          onChange={(e) => setFileName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              handleConfirm()
            }
          }}
          data-name="component.save-dialog.file-name-input"
        />

        <div className="save-dialog-label" data-name="component.save-dialog.directory-label">
          保存位置
        </div>
        <div className="save-dialog-directory-row">
          <span
            className="save-dialog-directory"
            title={directory}
            data-name="component.save-dialog.directory-value"
          >
            {directory}
          </span>
          <Button
            variant="outline"
            onClick={() => void handlePickDirectory()}
            disabled={picking}
            data-name="component.save-dialog.pick-directory-button"
          >
            {picking ? '选择中…' : '更改位置'}
          </Button>
        </div>

        <label className="save-dialog-checkbox" data-name="component.save-dialog.remember-label">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
            data-name="component.save-dialog.remember-checkbox"
          />
          <span>以后保存到这个位置（不再询问）</span>
        </label>

        <div className="save-dialog-actions" data-name="component.save-dialog.actions">
          <Button
            variant="outline"
            onClick={handleCancel}
            data-name="component.save-dialog.cancel-button"
          >
            取消
          </Button>
          <Button
            variant="primary"
            onClick={handleConfirm}
            disabled={!fileName.trim()}
            data-name="component.save-dialog.confirm-button"
          >
            保存
          </Button>
        </div>
      </div>
    </Modal>
  )
}
