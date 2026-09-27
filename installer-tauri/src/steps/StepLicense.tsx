// installer-tauri/src/steps/StepLicense.tsx
// 许可协议页：标签栏式切换，固定高度正文，逐个勾选同意

import type { InstallerInfo } from '../global'

export interface StepLicenseProps {
  info: InstallerInfo | null
  activeLicense: string | null
  setActiveLicense: (id: string) => void
  acceptedLicenses: string[]
  toggleLicense: (id: string) => void
}

export default function StepLicense({
  info,
  activeLicense,
  setActiveLicense,
  acceptedLicenses,
  toggleLicense,
}: StepLicenseProps) {
  const docs = info?.licenses ?? []
  const active = docs.find((d) => d.id === activeLicense) ?? docs[0]
  return (
    <>
      <h1 className="content__title">许可协议</h1>
      <p className="content__subtitle">请逐个阅读并勾选同意以下协议。</p>
      <div className="tabs" style={{ marginTop: 16 }}>
        {docs.map((d) => (
          <div
            key={d.id}
            className={`tab ${active?.id === d.id ? 'tab--active' : ''}`}
            onClick={() => setActiveLicense(d.id)}
          >
            {d.title}
          </div>
        ))}
      </div>
      <div className="license-body" style={{ marginTop: 14 }}>
        {active?.body ?? ''}
      </div>
      {active && (
        <div
          className="check-row license-accept"
          onClick={() => toggleLicense(active.id)}
        >
          <div className={`checkbox ${acceptedLicenses.includes(active.id) ? 'checkbox--checked' : ''}`}>
            {acceptedLicenses.includes(active.id) ? '✓' : ''}
          </div>
          <div className="check-row__text">我已阅读并同意《{active.title}》</div>
        </div>
      )}
    </>
  )
}
