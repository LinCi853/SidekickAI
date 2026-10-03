export interface LogExportOptions { startDate?: string; endDate?: string }
export interface LogExportResult { directory: string; files: number; warnings: number }

export function localLogDate(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function logDateRange(options: LogExportOptions = {}): { start: number; end: number } {
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || Object.keys(options).some(key => key !== 'startDate' && key !== 'endDate')) throw new Error('Invalid log date range')
  const parse = (value: unknown, end: boolean) => {
    if (value === undefined || value === '') return end ? Infinity : -Infinity
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Invalid log date')
    const [year, month, day] = value.split('-').map(Number)
    const date = new Date(year, month - 1, day)
    if (localLogDate(date) !== value) throw new Error('Invalid log date')
    if (end) date.setDate(date.getDate() + 1)
    return date.getTime()
  }
  const start = parse(options.startDate, false), end = parse(options.endDate, true)
  if (start >= end) throw new Error('Log start date must precede end date')
  return { start, end }
}
