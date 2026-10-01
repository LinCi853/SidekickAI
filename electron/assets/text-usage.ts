export function countCharacters(text: string): number {
  return Array.from(text).length
}

export function addedCharacters(previous: string, next: string): number {
  const left = Array.from(previous)
  const right = Array.from(next)
  let prefix = 0
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix++
  let suffix = 0
  while (suffix < left.length - prefix && suffix < right.length - prefix
    && left[left.length - suffix - 1] === right[right.length - suffix - 1]) suffix++
  return right.length - prefix - suffix
}

export function promptWeight(text: string, uses: number): number {
  const instruction = /(?:请|帮我|要求|输出|格式|扮演|总结|分析|生成|翻译|解释|please|write|summari[sz]e|explain|translate|act as|generate)/i.test(text)
  const template = /\{\{[^}]+\}\}|(?:^|\n)\s*(?:[-*]|\d+[.)]|#{1,6})\s/m.test(text)
  return (instruction ? 3 : 0) + (template ? 2 : 0) + Math.min(uses - 1, 5)
}
