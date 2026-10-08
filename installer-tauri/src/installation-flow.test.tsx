import { expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { WizardShell } from '../../installer-shared/presentation/Wizard'
import { INSTALL_MANIFEST } from '../../electron/shared/install-manifest-source'
import StepLocation from './steps/StepLocation'
import type { InstallerInfo } from './global'

it('presents bundled tools without unavailable download or component choices', () => {
  const info = { version: '0.1.6', distributionMode: 'offline', arch: 'x64',
    defaultDir: 'E:/Apps/SidekickAI-Concept', perUserDefaultDir: 'E:/Apps/SidekickAI-Concept', appName: 'SidekickAI', requiredSpace: '500 MB',
    features: INSTALL_MANIFEST.features, options: INSTALL_MANIFEST.options, licenses: [] } as InstallerInfo
  const noop = () => {}
  const markup = renderToStaticMarkup(<StepLocation stagingDir="" setStagingDir={noop} browseStagingDir={noop}
    actionName="安装" mode="install" info={info} scan={null} installDir="E:/Apps/SidekickAI-Concept" setInstallDir={noop}
    forAllUsers={false} setForAllUsers={noop} browseDir={noop} cleanupPaths={[]} toggleCleanup={noop}
    features={{}} toggleFeature={noop} cloudNotice="" cloudAssets={[]} optionsTab="behavior" setOptionsTab={noop}
    showGuideAfterInstall={false} setShowGuideAfterInstall={noop} options={{}} toggleOption={noop} setChoiceOption={noop} />)
  for (const label of ['仅为我安装', '为本机所有用户安装', '安装暂存位置', '安装完成后打开使用指南']) expect(markup).toContain(label)
  expect(markup).toContain('白板和其他内置工具随本体安装')
  expect(markup).not.toContain('下载失败')
  expect(markup).not.toContain('可选安装组件')
  expect(markup).not.toContain('启动时检查更新')
})

it('keeps the complete version identity while displaying the shared stable version form', () => {
  const version = '0.1.6+20261008.001'
  const markup = renderToStaticMarkup(<WizardShell version={version} stages={[]} currentIndex={0} onClose={() => {}}>content</WizardShell>)
  expect(markup).toContain(`title="${version}">v0.1.6</div>`)
})

it('shows a supplied distribution label before the version is ready', () => {
  const markup = renderToStaticMarkup(<WizardShell pendingVersionLabel="离线安装" stages={[]} currentIndex={0} onClose={() => {}}>content</WizardShell>)
  expect(markup).toContain('>离线安装</div>')
})
