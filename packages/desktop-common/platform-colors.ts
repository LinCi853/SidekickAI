export function derivePlatformGradient(hex: string): string {
  const expanded = /^#[\da-f]{3}$/i.test(hex) ? '#' + hex.slice(1).split('').map(char => char + char).join('') : hex
  const match = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(expanded)
  if (!match) return hex
  return '#' + match.slice(1).map(channel => Math.round(parseInt(channel, 16) * 0.8).toString(16).padStart(2, '0')).join('')
}
