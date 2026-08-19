// electron/stt/wav.ts — WAV 编码

/**
 * 将 Float32 PCM 转换为 16kHz mono 16-bit WAV Buffer
 * 供 whisper-cli 直接读取（whisper.cpp 接受标准 WAV 输入）。
 */
export function encodeWav(pcm: Float32Array, sampleRate: number): Buffer {
  const numChannels = 1
  const bytesPerSample = 2
  const blockAlign = numChannels * bytesPerSample
  const byteRate = sampleRate * blockAlign
  const dataSize = pcm.length * bytesPerSample
  const buffer = Buffer.alloc(44 + dataSize)

  // RIFF 头
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVE', 8)
  // fmt 块
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16) // 子块大小
  buffer.writeUInt16LE(1, 20) // 音频格式：1 = PCM
  buffer.writeUInt16LE(numChannels, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(byteRate, 28)
  buffer.writeUInt16LE(blockAlign, 32)
  buffer.writeUInt16LE(16, 34) // 位深度
  // data 块
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataSize, 40)

  // Float32 [-1.0, 1.0] -> Int16 [-32768, 32767]
  let offset = 44
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]))
    buffer.writeInt16LE(Math.round(s * 32767), offset)
    offset += 2
  }
  return buffer
}
