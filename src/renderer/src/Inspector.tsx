import { useEffect, useState } from 'react'
import { CATEGORY_LABELS, SUBTYPE_LABELS } from '../../shared/types'
import type { FileRow, ValueSource } from '../../shared/types'
import { formatBpm, formatDate, formatDuration, formatSize, stripExt } from './format'

const SOURCE_LABEL: Record<ValueSource, string> = {
  auto: 'auto',
  filename: 'from name',
  tag: 'from tag',
  analysis: 'detected',
  manual: 'manual'
}

export function Inspector({ fileId, version }: { fileId: number | null; version: number }): React.JSX.Element {
  const [file, setFile] = useState<FileRow | null>(null)

  useEffect(() => {
    if (fileId == null) setFile(null)
    else window.api.getFile(fileId).then(setFile)
  }, [fileId, version])

  if (!file) {
    return (
      <aside className="inspector">
        <div className="inspector-empty">Select a file to see its details.</div>
      </aside>
    )
  }

  const row = (label: string, value: React.ReactNode, source?: ValueSource | null): React.JSX.Element => (
    <div className="kv">
      <div className="k">{label}</div>
      <div className="v">
        {value}
        {source && <span className="src">{SOURCE_LABEL[source]}</span>}
      </div>
    </div>
  )

  const channels = file.channels === 1 ? 'Mono' : file.channels === 2 ? 'Stereo' : file.channels ? String(file.channels) : '—'

  return (
    <aside className="inspector">
      <div className="insp-title">{stripExt(file.name)}</div>
      <div className="insp-path" title={file.path}>
        {file.path}
      </div>
      {file.status !== 'ok' && (
        <div className="insp-warn">{file.status === 'missing' ? 'File not found at this path.' : 'Folder is offline.'}</div>
      )}
      <div className="insp-group">
        {row('Category', <span className={`pill cat-${file.category}`}>{CATEGORY_LABELS[file.category]}</span>, file.categorySource)}
        {file.subtype && row('Type', SUBTYPE_LABELS[file.subtype])}
        {row('BPM', formatBpm(file.bpm), file.bpmSource)}
        {row('Key', file.key ?? '—', file.keySource)}
      </div>
      <div className="insp-group">
        {row('Length', formatDuration(file.durationMs))}
        {row('Sample rate', file.sampleRate ? `${(file.sampleRate / 1000).toFixed(1)} kHz` : '—')}
        {row('Bit depth', file.bitDepth ? `${file.bitDepth}-bit` : '—')}
        {row('Channels', channels)}
        {row('Format', file.ext.toUpperCase())}
        {row('Size', formatSize(file.size))}
        {row('Added', formatDate(file.dateAdded))}
      </div>
      <button className="btn" onClick={() => window.api.revealFile(file.id)}>
        Show in folder
      </button>
    </aside>
  )
}
