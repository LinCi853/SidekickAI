import { createHash } from 'node:crypto'
export { classifyCapturedNoise } from './noise-classifier.js'

export function captureSignature(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}
