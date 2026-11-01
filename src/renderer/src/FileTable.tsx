import { useVirtualizer } from '@tanstack/react-virtual'
import { useEffect, useRef } from 'react'
import { CATEGORY_SHORT, SUBTYPE_LABELS } from '../../shared/types'
import type { FileRow, SortField } from '../../shared/types'
import { formatBpm, formatDate, formatDuration, stripExt } from './format'
import { Stars } from './Stars'
import type { FileList } from './useFileList'

export interface ClickMods {
  /** Ctrl on Windows, Cmd on macOS: add/remove one row. */
  toggle: boolean
  /** Shift: select the range from the last clicked row. */
  range: boolean
}

interface Props {
  list: FileList
  sort: { field: SortField; desc: boolean }
  onSort: (f: SortField) => void
  focus: { id: number; index: number } | null
  selection: Set<number>
  onRowClick: (index: number, row: FileRow, mods: ClickMods) => void
  onRate: (row: FileRow, rating: number) => void
  onFavorite: (row: FileRow) => void
}

const COLUMNS: Array<{ field: SortField | null; label: string; className: string; title?: string }> = [
  { field: null, label: '', className: 'c-ext' },
  { field: null, label: '♥', className: 'c-fav', title: 'Favorite' },
  { field: 'name', label: 'Name', className: 'c-name' },
  { field: 'category', label: 'Category', className: 'c-cat' },
  { field: 'subtype', label: 'Type', className: 'c-sub' },
  { field: 'bpm', label: 'BPM', className: 'c-num' },
  { field: 'key', label: 'Key', className: 'c-key' },
  { field: 'duration', label: 'Length', className: 'c-num' },
  { field: 'rating', label: 'Rating', className: 'c-rating' },
  { field: 'dateAdded', label: 'Added', className: 'c-date' }
]

const ROW_HEIGHT = 30
const isMac = navigator.platform.toLowerCase().includes('mac')

export function FileTable({ list, sort, onSort, focus, selection, onRowClick, onRate, onFavorite }: Props): React.JSX.Element {
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

  // Keep the keyboard focus on screen.
  const focusIndex = focus?.index
  useEffect(() => {
    if (focusIndex != null) virtualizer.scrollToIndex(focusIndex, { align: 'auto' })
  }, [focusIndex, virtualizer])

  return (
    <div className="table">
      <div className="thead">
        {COLUMNS.map((c, i) =>
          c.field ? (
            <button key={c.field} className={`th ${c.className}${sort.field === c.field ? ' sorted' : ''}`} onClick={() => onSort(c.field!)}>
              {c.label}
              {sort.field === c.field && <span className="sort-arrow">{sort.desc ? '▼' : '▲'}</span>}
            </button>
          ) : (
            <div key={i} className={`th ${c.className}`} title={c.title}>
              {c.label}
            </div>
          )
        )}
      </div>
      <div className="tbody" ref={scrollRef}>
        {list.total === 0 && <div className="empty">No files here yet. Add a folder on the left to start indexing.</div>}
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {items.map((vi) => {
            const f = list.rowAt(vi.index)
            const style = { transform: `translateY(${vi.start}px)`, height: ROW_HEIGHT }
            if (!f) return <div key={vi.key} className="tr loading" style={style} />
            const isSelected = selection.has(f.id)
            return (
              <div
                key={vi.key}
                className={`tr${isSelected ? ' selected' : ''}${f.id === focus?.id ? ' focused' : ''}${f.status !== 'ok' ? ' dim' : ''}`}
                style={style}
                onClick={(e) => onRowClick(vi.index, f, { toggle: isMac ? e.metaKey : e.ctrlKey, range: e.shiftKey })}
                draggable={f.status === 'ok'}
                onDragStart={(e) => {
                  // Hand off to the OS drag so Ableton/Finder/Explorer get the real files.
                  // Dragging a selected row takes the whole selection with it.
                  e.preventDefault()
                  window.api.startDrag(isSelected ? [...selection] : [f.id])
                }}
                onDoubleClick={() => window.api.revealFile(f.id)}
                title={f.path}
              >
                <div className="c-ext">
                  <span className={`ext ext-${f.ext}`}>{f.ext}</span>
                </div>
                <div className="c-fav">
                  <button
                    className={`fav-btn small${f.favorite ? ' on' : ''}`}
                    title={f.favorite ? 'Remove from favorites' : 'Add to favorites'}
                    onClick={(e) => {
                      e.stopPropagation()
                      onFavorite(f)
                    }}
                  >
                    ♥
                  </button>
                </div>
                <div className="td c-name">
                  {stripExt(f.name)}
                  {f.tags.length > 0 && <span className="row-tags">{f.tags.join(' · ')}</span>}
                </div>
                <div className="td c-cat">
                  <span className={`pill cat-${f.category}`}>{CATEGORY_SHORT[f.category]}</span>
                </div>
                <div className="td c-sub">{f.subtype ? SUBTYPE_LABELS[f.subtype] : ''}</div>
                <div className="td c-num">{formatBpm(f.bpm)}</div>
                <div className="td c-key">{f.key ?? '—'}</div>
                <div className="td c-num">{formatDuration(f.durationMs)}</div>
                <div className="c-rating">
                  <Stars size="small" value={f.rating} onChange={(r) => onRate(f, r)} />
                </div>
                <div className="td c-date">{formatDate(f.dateAdded)}</div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
