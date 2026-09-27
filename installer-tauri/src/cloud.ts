import type { CloudAssetWire, InstallationResourceStatus } from './global'

export function hostContext(architecture: 'x64' | 'arm64', installerVersion: string) {
  return { platform: 'windows', architecture, installerVersion }
}

export async function prepareCloudAssets(_input: { host: ReturnType<typeof hostContext>; selectedComponents: string[] }): Promise<{ notice: string; assets: CloudAssetWire[]; resources: InstallationResourceStatus[] }> {
  return { notice: '', assets: [], resources: [] }
}
