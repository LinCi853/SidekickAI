/** 时间戳格式化
 * @param ts 毫秒时间戳
 * @param mode 'time'=HH:MM, 'datetime'=YYYY-MM-DD HH:MM
 */
export function formatTime(ts: number, mode: 'time' | 'datetime' = 'datetime'): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  if (mode === 'time') {
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
