// electron/stt/binary-resolver.ts — whisper-cli 二进制跨平台路径解析与下载分发
//
// 统一管理三件事，消除原 engine.ts / voice-store.ts 中的硬编码 process.platform 三元判断，
// 并将 voice-ipc.ts 的下载 URL 从仅 Windows x64 扩展到 darwin-x64 / darwin-arm64 / linux-x64：
//   1. whisper-cli 可执行文件名候选（按平台）
//   2. whisper-cli 预编译包下载资产信息（按平台+架构）
//   3. 下载镜像 URL 列表（官方 + 国内镜像）
//
// 注意：whisper.cpp release 历史上 v1.7.x 提供 whisper-bin-x64.zip（Windows x64 预编译），
// v1.7.4 起仅源码。固定到 v1.9.1（带 Windows x64 预编译 zip）。
// darwin / linux 预编译包文件名按平台命名，实际可用性取决于 release/CDN，模块仅负责拼接 URL。

/** whisper-cli 预编译包版本（固定到带预编译资产的 release） */
const WHISPER_CLI_RELEASE_VERSION = 'v1.9.1'

/** whisper-cli 预编译包基础信息（按平台+架构） */
interface WhisperCliAsset {
  /** release 资产文件名，如 'whisper-bin-x64.zip' */
  fileName: string
  /** 预期解压大小（字节，用于下载进度校验，0 表示不校验） */
  expectedSize: number
  /** 可选 SHA256 校验和 */
  checksum?: string
}

/**
 * 各平台+架构的预编译资产映射。
 *
 * 文件名约定：
 *   - Windows 沿用 whisper.cpp release 原生命名 whisper-bin-x64.zip / whisper-bin-arm64.zip
 *   - macOS / Linux 按平台后缀命名，便于未来 CDN 区分分发
 *
 * 实际可用性：v1.9.1 release 仅确认 Windows x64 预编译存在；其他平台预编译包
 * 由用户/CI 自行上传到对应 URL 后即可被下载逻辑识别。
 */
const ASSET_MAP: Record<string, WhisperCliAsset> = {
  'win32-x64': { fileName: 'whisper-bin-x64.zip', expectedSize: 8 * 1024 * 1024 },
  'win32-arm64': { fileName: 'whisper-bin-arm64.zip', expectedSize: 8 * 1024 * 1024 },
  'darwin-x64': { fileName: 'whisper-bin-macos-x64.zip', expectedSize: 8 * 1024 * 1024 },
  'darwin-arm64': { fileName: 'whisper-bin-macos-arm64.zip', expectedSize: 8 * 1024 * 1024 },
  'linux-x64': { fileName: 'whisper-bin-linux-x64.zip', expectedSize: 8 * 1024 * 1024 },
}

/**
 * 获取 whisper-cli 可执行文件候选名（按平台）。
 */
export function getWhisperCliBinaryNames(
  platform: NodeJS.Platform = process.platform,
): string[] {
  return platform === 'win32'
    ? ['whisper-cli.exe']
    : ['whisper-cli']
}

/**
 * 获取 whisper-cli 预编译包下载资产信息（按平台+架构）。
 *
 * 回退策略：精确匹配 → 同平台 x64 → win32-x64（兜底，确保总返回有效 URL）。
 */
export function getWhisperCliAssetInfo(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): {
  fileName: string
  downloadUrl: string
  expectedSize: number
  checksum?: string
} {
  const key = `${platform}-${arch}`
  const asset = ASSET_MAP[key] || ASSET_MAP[`${platform}-x64`] || ASSET_MAP['win32-x64']
  const downloadUrl = `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_CLI_RELEASE_VERSION}/${asset.fileName}`
  return {
    fileName: asset.fileName,
    downloadUrl,
    expectedSize: asset.expectedSize,
    checksum: asset.checksum,
  }
}

/**
 * 获取 whisper-cli 下载镜像 URL 列表（官方 + 国内镜像）。
 *
 * 顺序：国内镜像优先（GitHub 直连在国内几乎不可用），GitHub 直连作为最后 fallback。
 * 镜像以 URL 前缀方式拼接，codeload 类型的 zip 走同一规则。
 */
export function getWhisperCliDownloadMirrors(
  assetFileName: string = getWhisperCliAssetInfo().fileName,
): string[] {
  const ghUrl = `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_CLI_RELEASE_VERSION}/${assetFileName}`
  return [
    `https://ghfast.top/${ghUrl}`,
    `https://gh-proxy.com/${ghUrl}`,
    `https://ghproxy.net/${ghUrl}`,
    `https://ghps.cc/${ghUrl}`,
    `https://mirror.ghproxy.com/${ghUrl}`,
    `https://download.fastgit.org/ggml-org/whisper.cpp/releases/download/${WHISPER_CLI_RELEASE_VERSION}/${assetFileName}`,
    ghUrl, // GitHub 直连作为最后 fallback
  ]
}

/**
 * 获取 whisper 模型下载镜像 URL 列表。
 * 国内访问 HuggingFace 常被墙，hf-mirror 优先。
 */
export function getWhisperModelUrls(modelFileName: string): string[] {
  return [
    `https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/${modelFileName}`,
    `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${modelFileName}`,
  ]
}

/** 按当前平台导出 whisper-cli 候选文件名常量 */
export const WHISPER_CLI_BINARIES = getWhisperCliBinaryNames()
