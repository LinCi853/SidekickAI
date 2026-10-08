// installer-tauri/src/components/ComponentsPanel.tsx
// 独立安装组件 + 云端下载（同一安装页，由用户勾选）

import type { CloudAssetWire, InstallerInfo } from '../global'
import { installationPolicy } from '../../../installer-shared/edition-policy'

export interface ComponentsPanelProps {
  info: InstallerInfo | null
  features: Record<string, boolean>
  toggleFeature: (id: string) => void
  cloudNotice: string
  cloudAssets: CloudAssetWire[]
  embedded?: boolean
}

export default function ComponentsPanel({
  info,
  features,
  toggleFeature,
  cloudNotice,
  cloudAssets,
  embedded = false,
}: ComponentsPanelProps) {
  const requiredFeatures = info?.features.filter((f) => f.installRequired) ?? []
  return (
    <div style={{ marginTop: embedded ? 0 : 18 }}>
      {requiredFeatures.length > 0 && <div className="field-label">可选安装组件</div>}
      {requiredFeatures.length > 0 && (
        <div className="opt-group">
          {requiredFeatures.map((f) => (
            <div
              key={f.id}
              className={`check-row check-row--rich ${f.required ? 'check-row--locked' : ''}`}
              onClick={() => {
                if (!f.required) toggleFeature(f.id)
              }}
            >
              <div className={`checkbox ${features[f.id] ? 'checkbox--checked' : ''}`}>
                {features[f.id] ? '✓' : ''}
              </div>
              <div className="check-row__text">
                <div className="opt-title">
                  {f.name}
                  {f.required ? <span className="opt-tag">核心</span> : null}
                </div>
                <div className="opt-desc">{f.description}</div>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="field-label" style={{ marginTop: 14 }}>默认内容</div>
      <div className="hint" style={{ marginTop: 8 }}>
        <span className="hint__icon">i</span>
        <span>{installationPolicy.contentDescription}</span>
      </div>
      {cloudNotice && (
        <div className="hint hint--warning" style={{ marginTop: 8 }}>
          <span className="hint__icon">!</span>
          <span>{cloudNotice}</span>
        </div>
      )}
      {cloudAssets.length > 0 && (
        <div className="hint" style={{ marginTop: 8 }}>
          <span className="hint__icon">✓</span>
          <span>已准备 {cloudAssets.length} 项云端资源，安装时校验后写入。</span>
        </div>
      )}
    </div>
  )
}
