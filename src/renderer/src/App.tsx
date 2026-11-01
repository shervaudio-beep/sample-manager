import { useCallback, useEffect, useRef, useState } from 'react'
import type { Category, DrumSubtype, FilePatch, FileRow, LibraryCounts, Root, ScanEvent, SortField, TagInfo } from '../../shared/types'
import { CATEGORY_LABELS, SUBTYPE_LABELS } from '../../shared/types'
import { FileTable, type ClickMods } from './FileTable'
import { Inspector } from './Inspector'
import { PlayerBar, type PlayerHandle } from './PlayerBar'
import { Sidebar } from './Sidebar'
import { useFileList } from './useFileList'

export interface ScanState {
  running: boolean
  rootPath: string
  found: number
  processed: number
  message: string
}

export interface View {
  category?: Category
  subtype?: DrumSubtype
  rootId?: number
  favorite?: boolean
  tagId?: number
}

const isMac = navigator.platform.toLowerCase().includes('mac')

export function App(): React.JSX.Element {
  const [roots, setRoots] = useState<Root[]>([])
  const [counts, setCounts] = useState<LibraryCounts | null>(null)
  const [tags, setTags] = useState<TagInfo[]>([])
  const [view, setView] = useState<View>({})
  const [sort, setSort] = useState<{ field: SortField; desc: boolean }>({ field: 'dateAdded', desc: true })
  // `focus` is the row the keyboard and player follow; `selection` is what edits and drags apply to.
  const [focus, setFocus] = useState<{ id: number; index: number } | null>(null)
  const [selection, setSelection] = useState<Set<number>>(new Set())
  const anchor = useRef<number | null>(null)
  const [version, setVersion] = useState(0)
  const [scan, setScan] = useState<ScanState>({ running: false, rootPath: '', found: 0, processed: 0, message: '' })
  const lastRefresh = useRef(0)
  const player = useRef<PlayerHandle>(null)
  const heldArrow = useRef(false)

  const refreshLibrary = useCallback(() => {
    window.api.listRoots().then(setRoots)
    window.api.counts().then(setCounts)
    window.api.listTags().then(setTags)
    setVersion((v) => v + 1)
  }, [])

  useEffect(() => {
    refreshLibrary()
    window.api.isScanning().then((running) => setScan((s) => ({ ...s, running })))
    return window.api.onScanEvent((e: ScanEvent) => {
      switch (e.type) {
        case 'start':
          setScan({ running: true, rootPath: e.path, found: 0, processed: 0, message: '' })
          break
        case 'progress':
          setScan((s) => ({ ...s, running: true, found: e.found, processed: e.processed }))
          // Show new files as they land, but don't hammer the DB: at most every 1.5 s.
          if (Date.now() - lastRefresh.current > 1500) {
            lastRefresh.current = Date.now()
            refreshLibrary()
          }
          break
        case 'rootDone': {
          const s = e.summary
          const message = s.offline
            ? 'Folder is offline (drive unplugged?). Its files are kept in the library.'
            : `${s.added} new, ${s.updated} changed, ${s.missing} missing, ${s.relinked} moved` +
              (s.errors ? `, ${s.errors} unreadable` : '')
          setScan((st) => ({ ...st, message }))
          refreshLibrary()
          break
        }
        case 'error':
          setScan((st) => ({ ...st, message: `Scan error: ${e.message}` }))
          break
        case 'done':
          setScan((st) => ({ ...st, running: false }))
          refreshLibrary()
          break
      }
    })
  }, [refreshLibrary])

  const filter = {
    category: view.category,
    subtype: view.subtype,
    rootId: view.rootId,
    favorite: view.favorite,
    tagId: view.tagId,
    sort: sort.field,
    desc: sort.desc
  }
  const list = useFileList(filter, version)

  const clearSelection = (): void => {
    setFocus(null)
    setSelection(new Set())
    anchor.current = null
  }

  const onSort = (field: SortField): void => {
    setSort((s) => (s.field === field ? { field, desc: !s.desc } : { field, desc: field === 'dateAdded' || field === 'rating' }))
    clearSelection()
  }

  const selectOne = (index: number, row: FileRow, preview = true): void => {
    setFocus({ id: row.id, index })
    setSelection(new Set([row.id]))
    anchor.current = index
    if (preview) player.current?.play(row)
  }

  const selectRange = async (from: number, to: number, row: FileRow, keep: Set<number> | null): Promise<void> => {
    const start = Math.min(from, to)
    const ids = await window.api.queryIds({ ...filter, offset: start, limit: Math.abs(to - from) + 1 })
    setSelection(new Set([...(keep ?? []), ...ids]))
    setFocus({ id: row.id, index: to })
  }

  const onRowClick = (index: number, row: FileRow, mods: ClickMods): void => {
    if (mods.range && anchor.current != null) {
      selectRange(anchor.current, index, row, mods.toggle ? selection : null)
    } else if (mods.toggle) {
      const next = new Set(selection)
      if (next.has(row.id)) next.delete(row.id)
      else next.add(row.id)
      setSelection(next)
      setFocus({ id: row.id, index })
      anchor.current = index
    } else {
      selectOne(index, row)
    }
  }

  const edit = async (ids: number[], patch: FilePatch): Promise<void> => {
    if (!ids.length) return
    await window.api.updateFiles(ids, patch)
    refreshLibrary()
  }

  /** Rating or favoriting a row inside the selection applies to the whole selection. */
  const targetIds = (row: FileRow): number[] => (selection.has(row.id) ? [...selection] : [row.id])

  // Space: play/stop. Up/Down: move and auto-preview (Shift extends the selection). Esc: stop.
  // 1-5: rate, 0: clear rating, F: favorite. Ctrl/Cmd+A: select all.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement
      if (t.closest('input, textarea, select, [contenteditable]')) return
      const mod = isMac ? e.metaKey : e.ctrlKey
      if (mod && e.code === 'KeyA') {
        e.preventDefault()
        window.api.queryIds(filter).then((ids) => setSelection(new Set(ids)))
        return
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const current = focus ? list.rowAt(focus.index) : undefined
      const digit = /^(?:Digit|Numpad)([0-5])$/.exec(e.code)

      if (e.code === 'Space') {
        e.preventDefault()
        player.current?.toggle(current ?? null)
      } else if (e.code === 'Escape') {
        player.current?.stop()
      } else if (digit && selection.size) {
        edit([...selection], { rating: Number(digit[1]) })
      } else if (e.code === 'KeyF' && selection.size) {
        edit([...selection], { favorite: !(current?.favorite ?? false) })
      } else if (e.code === 'ArrowDown' || e.code === 'ArrowUp') {
        e.preventDefault()
        if (!list.total) return
        const step = e.code === 'ArrowDown' ? 1 : -1
        const next = focus ? Math.min(list.total - 1, Math.max(0, focus.index + step)) : 0
        if (focus && next === focus.index) return
        const row = list.rowAt(next)
        if (!row) return
        if (e.shiftKey && anchor.current != null) {
          selectRange(anchor.current, next, row, null)
          return
        }
        // Holding the key scrolls without firing a preview per row; the release previews.
        selectOne(next, row, !e.repeat)
        heldArrow.current = e.repeat
      }
    }
    const onKeyUp = (e: KeyboardEvent): void => {
      if ((e.code === 'ArrowDown' || e.code === 'ArrowUp') && heldArrow.current && focus) {
        heldArrow.current = false
        const row = list.rowAt(focus.index)
        if (row) player.current?.play(row)
      }
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKeyUp)
    }
  })

  return (
    <div className="app">
      <Sidebar
        roots={roots}
        counts={counts}
        tags={tags}
        view={view}
        scan={scan}
        onView={(v) => {
          setView(v)
          clearSelection()
        }}
        onAddFolders={() => window.api.addRoots().then(refreshLibrary)}
        onRemoveRoot={async (root) => {
          const ok = window.confirm(
            `Remove "${root.path}" from the library?\n\nYour files on disk are NOT touched. Tags, ratings and notes for files in this folder will be forgotten.`
          )
          if (!ok) return
          await window.api.removeRoot(root.id)
          if (view.rootId === root.id) setView({})
          clearSelection()
          refreshLibrary()
        }}
        onRescan={(rootIds) => window.api.startScan(rootIds)}
      />
      <main className="main">
        <div className="toolbar">
          <div className="toolbar-title">{viewTitle(view, roots, tags)}</div>
          <div className="toolbar-count">
            {list.total.toLocaleString()} files
            {selection.size > 1 && <span className="toolbar-sel"> · {selection.size.toLocaleString()} selected</span>}
          </div>
          {scan.running && (
            <div className="toolbar-scan">
              <span className="spinner" /> Scanning… {scan.processed.toLocaleString()} / {scan.found.toLocaleString()}
            </div>
          )}
        </div>
        <FileTable
          list={list}
          sort={sort}
          onSort={onSort}
          focus={focus}
          selection={selection}
          onRowClick={onRowClick}
          onRate={(row, rating) => edit(targetIds(row), { rating })}
          onFavorite={(row) => edit(targetIds(row), { favorite: !row.favorite })}
        />
      </main>
      <Inspector ids={[...selection]} version={version} allTags={tags} onChanged={refreshLibrary} />
      <PlayerBar ref={player} version={version} />
    </div>
  )
}

function viewTitle(view: View, roots: Root[], tags: TagInfo[]): string {
  if (view.rootId != null) return roots.find((r) => r.id === view.rootId)?.path ?? 'Folder'
  if (view.favorite) return 'Favorites'
  if (view.tagId != null) return '# ' + (tags.find((t) => t.id === view.tagId)?.name ?? 'Tag')
  if (view.subtype) return 'Drums › ' + SUBTYPE_LABELS[view.subtype]
  if (view.category) return CATEGORY_LABELS[view.category]
  return 'All Files'
}
