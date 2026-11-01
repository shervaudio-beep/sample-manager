export function formatDuration(ms: number | null): string {
  if (ms == null) return '—'
  if (ms < 10_000) return (ms / 1000).toFixed(2) + 's'
  const s = Math.round(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

export function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

export function formatBpm(bpm: number | null): string {
  if (bpm == null) return '—'
  return Number.isInteger(bpm) ? String(bpm) : bpm.toFixed(1)
}

export function stripExt(name: string): string {
  return name.replace(/\.[^.]+$/, '')
}
