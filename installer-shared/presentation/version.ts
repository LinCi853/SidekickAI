const stableVersion = /^((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$(?![\s\S])/

/** Stable releases show the product version while retaining build metadata in details. */
export function formatVersion(value: string): string {
  return stableVersion.exec(value)?.[1] ?? value
}
