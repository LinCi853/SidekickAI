// HotkeyRecorder.tsx — 快捷键录入组件
//
// 点击输入框进入录入模式，通过主进程 uiohook 系统级键盘钩子捕获按键组合。
// 录入完成后自动检测本地冲突（与其他热键重复）和系统占用。
// Alt+key 等被系统拦截的组合也能可靠捕获。

import { useState, useCallback, useRef, useEffect } from 'react'
import { checkSystemHotkeyConflict } from '../../lib/system-hotkeys'

/**
 * 模块级：当前活跃的录制器重置函数。
 * 同一窗口内可能有多个 HotkeyRecorder 实例（设置面板、使用指南），
 * 点击新录制器时先重置旧的，确保同一时刻只有一个在录制。
 */
let resetActiveRecorder: (() => void) | null = null

export interface OtherHotkey {
  label: string
  accelerator: string
}

export interface HotkeyRecorderProps {
  /** 当前 accelerator 值（draft） */
  value: string
  /** 占位提示 */
  placeholder?: string
  /** 录入成功回调（accelerator 有效时触发） */
  onRecord: (accelerator: string) => void
  /** 用于本地冲突检测的其他热键列表 */
  otherHotkeys: OtherHotkey[]
  /** 开始录制（主进程 globalShortcut 捕获） */
  startRecording: () => Promise<boolean>
  /** 停止录制 */
  stopRecording: () => Promise<void>
  /** 监听录制结果 */
  onRecordingResult: (cb: (result: { accelerator: string; reason?: string }) => void) => () => void
  /** 传入的 CSS 类名 */
  className?: string
  /** 是否禁用 */
  disabled?: boolean
}

export default function HotkeyRecorder({
  value,
  placeholder,
  onRecord,
  otherHotkeys,
  startRecording,
  stopRecording,
  onRecordingResult,
  className,
  disabled,
}: HotkeyRecorderProps) {
  const [recording, setRecording] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const recordingRef = useRef(false)

  // 录制结果监听：组件挂载时订阅，录制状态下处理结果
  useEffect(() => {
    const unsubscribe = onRecordingResult((result) => {
      if (!recordingRef.current) return
      recordingRef.current = false
      setRecording(false)
      resetActiveRecorder = null

      // 空 accelerator 表示用户按 Esc 取消
      if (!result.accelerator) {
        setError(null)
        return
      }

      if (result.reason) {
        setError(result.reason)
        return
      }

      // 本地冲突检测
      const conflictWith = otherHotkeys.find((h) => h.accelerator === result.accelerator)
      if (conflictWith) {
        setError(`与「${conflictWith.label}」冲突`)
        return
      }

      // 系统快捷键冲突检测：仅警告，不阻止（用户可强行使用）
      const sysConflict = checkSystemHotkeyConflict(result.accelerator)
      if (sysConflict) {
        setError(`与系统快捷键「${sysConflict.label}」可能冲突`)
        onRecord(result.accelerator)
        return
      }

      setError(null)
      onRecord(result.accelerator)
    })
    return () => {
      unsubscribe()
      // 组件卸载时停止录制
      if (recordingRef.current) {
        recordingRef.current = false
        resetActiveRecorder = null
        void stopRecording()
      }
    }
  }, [onRecordingResult, otherHotkeys, onRecord, stopRecording])

  const handleClick = useCallback(async () => {
    if (disabled) return
    setError(null)
    // 重置之前活跃的录制器（同一窗口内只允许一个录制）
    if (resetActiveRecorder) {
      resetActiveRecorder()
      resetActiveRecorder = null
    }
    setRecording(true)
    recordingRef.current = true
    // 注册自己的重置函数，供下一个录制器调用
    resetActiveRecorder = () => {
      recordingRef.current = false
      setRecording(false)
    }
    const ok = await startRecording()
    if (!ok) {
      setRecording(false)
      recordingRef.current = false
      resetActiveRecorder = null
      setError('无法启动录制，请重试')
    }
  }, [disabled, startRecording])

  const displayValue = recording ? '按下快捷键…（Esc 取消）' : value
  const inputClass = [
    className ?? '',
    recording ? ' is-recording' : '',
    error ? ' has-error' : '',
  ].join(' ')

  return (
    <div
      className="hotkey-recorder-wrapper"
      style={{ position: 'relative', flex: 1 }}
      data-name="ui.hotkey-recorder.wrapper"
    >
      <input
        type="text"
        className={inputClass.trim()}
        value={displayValue}
        placeholder={recording ? undefined : placeholder}
        readOnly
        disabled={disabled}
        onClick={() => void handleClick()}
        data-name="ui.hotkey-recorder.input"
      />
      {error && (
        <span
          style={{
            display: 'block',
            marginTop: '4px',
            fontSize: '11px',
            color: 'var(--danger, #ef4444)',
          }}
          data-name="ui.hotkey-recorder.error-message"
        >
          {error}
        </span>
      )}
    </div>
  )
}
