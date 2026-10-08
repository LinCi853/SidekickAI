export type NativeArchitecture = 'x64' | 'arm64'
export type ReleaseChannel = 'stable' | 'alpha' | 'beta' | 'rc'
export interface UpdateAsset {
  assetId: string
  role: 'offline-installer' | 'portable'
  filename: string
  sizeBytes: number
  sha256: string
  contentType: string
  executableArchitecture: NativeArchitecture | null
  supportedNativeArchitectures: NativeArchitecture[]
  bodyProofSha256: string
}
export interface UpdateRelease {
  protocolVersion: 1
  productId: 'sidekickai'
  edition: 'concept'
  productVersion: string
  releaseId: string
  channel: ReleaseChannel
  platform: 'windows'
  maintenanceProtocolVersion: 1
  recoveryProtocolVersion: 1
  assets: UpdateAsset[]
  publicAssetIds: string[]
  architectureEvidence: Array<{ nativeArchitecture: NativeArchitecture; evidenceId: string; testedAt: string; nativePackageVerified: true }>
  notes: string
  createdAt: string
}
export interface UpdateOffer {
  id: string
  version: string
  notes: string
  sizeBytes: number
  kind: 'installed' | 'portable'
}
export interface UpdateState {
  phase: 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'ready' | 'failed'
  offer: UpdateOffer | null
  downloadedBytes: number
  error: string | null
}
export interface UpdatesAPI {
  getState(): Promise<UpdateState>
  check(): Promise<UpdateState>
  accept(offerId: string): Promise<UpdateState>
  cancel(): Promise<void>
  openReleases(): Promise<void>
}
export interface DistributionKey {
  id: string
  publicKey: { kty: 'OKP'; crv: 'Ed25519'; x: string }
}
export const UPDATE_IPC = {
  state: 'application-updates:state', check: 'application-updates:check', accept: 'application-updates:accept',
  cancel: 'application-updates:cancel', releases: 'application-updates:releases',
} as const
