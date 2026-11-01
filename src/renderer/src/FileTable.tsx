import { useVirtualizer } from '@tanstack/react-virtual'
import { useEffect, useRef } from 'react'
import { CATEGORY_SHORT, SUBTYPE_LABELS } from '../../shared/types'
import type { SortField } from '../../shared/types'
import { formatBpm, formatDate, formatDuration, formatSize, stripExt } from './format'
import type { FileList } from './useFileList'

interface Props {
  list: FileList
  sort: { field: SortField; desc: boolean }
  onSort: (f: SortField) => void
  selectedId: number | null
  onSelect: (id: number) => void
}

const COLUMNS: Array<{ field: SortField; label: string; className: string }> = [
  { field: 'name', label: 'Name', className: 'c-name' },
  { field: 'category', label: 'Category', className: 'c-cat' },
  { field: 'subtype', label: 'Type', className: 'c-sub' },
  { field: 'bpm', label: 'BPM', className: 'c-num' },
  { field: 'key', label: 'Key', className: 'c-key' },
  { field: 'duration', label: 'Length', className: 'c-num' },
  { field: 'size', label: 'Size', className: 'c-num' },
  { field: 'dateAdded', label: 'Added', className: 'c-date' }
]

const ROW_HEIGHT = 30

export function FileTable({ list, sort, onSort, selectedId, onSelect }: Props): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: list.total,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20
  })
  const items = virtualizer.getVirtualItems()
  const first = items[0]?.index ?? 0
  const last = items[items.length - 1]?.index ?? 0

  useEffect(() => {
    list.ensureRange(first, last)
  }, [first, last, list])

  return (
    <div className="table">
      <div className="thead">
        <div className="c-ext" />
        {COLUMNS.map((c) => (
          <button key={c.field} className={`th ${c.className}${sort.field === c.field ? ' sorted' : ''}`} onClick={() => onSort(c.field)}>
            {c.label}
            {sort.field === c.field && <span className="sort-arrow">{sort.desc ? '▼' : '▲'}</span>}
          </button>
        ))}
      </div>
      <div className="tbody" ref={scrollRef}>
        {list.total === 0 && <div className="empty">No files here yet. Add a folder on the left to start indexing.</div>}
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {items.map((vi) => {
            const f = list.rowAt(vi.index)
            const style = { transform: `translateY(${vi.start}px)`, height: ROW_HEIGHT }
            if (!f) return <div key={vi.key} className="tr loading" style={style} />
            return (
              <div
                key={vi.key}
                className={`tr${f.id === selectedId ? ' selected' : ''}${f.status !== 'ok' ? ' dim' : ''}`}
                style={style}
                onClick={() => onSelect(f.id)}
                onDoubleClick={() => window.api.revealFile(f.id)}
                title={f.path}
              >
                <div className="c-ext">
                  <span className={`ext ext-${f.ext}`}>{f.ext}</span>
                </div>
                <div className="td c-name">{stripExt(f.name)}</div>
                <div className="td c-cat">
                  <span className={`pill cat-${f.category}`}>{CATEGORY_SHORT[f.category]}</span>
                </div>
                <div className="td c-sub">{f.subtype ? SUBTYPE_LABELS[f.subtype] : ''}</div>
                <div className="td c-num">{formatBpm(f.bpm)}</div>
                <div className="td c-key">{f.key ?? '—'}</div>
                <div className="td c-num">{formatDuration(f.durationMs)}</div>
                <div className="td c-num">{formatSize(f.size)}</div>
                <div className="td c-date">{formatDate(f.dateAdded)}</div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
