import { useCallback, useEffect, useRef, useState } from 'react'
import type { Category, Collection, DrumSubtype, DupeEvent, FilePatch, FileRow, LibraryCounts, Root, ScanEvent, SortField, TagInfo } from '../../shared/types'
import { CATEGORY_LABELS, SUBTYPE_LABELS } from '../../shared/types'
import { FileTable, type ClickMods } from './FileTable'
import { activeFilterCount, FilterBar, filtersToQuery, NO_FILTERS, SearchBox, type Filters } from './FilterBar'
import { DupesBar } from './DupesBar'
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
  collectionId?: number
  duplicates?: boolean
}

export interface DupeState {
  running: boolean
  stage: Extract<DupeEvent, { type: 'progress' }>['stage'] | null
  done: number
  total: number
}

const isMac = navigator.platform.toLowerCase().includes('mac')

export function App(): React.JSX.Element {
  const [roots, setRoots] = useState<Root[]>([])
  const [counts, setCounts] = useState<LibraryCounts | null>(null)
  const [tags, setTags] = useState<TagInfo[]>([])
  const [collections, setCollections] = useState<Collection[]>([])
  const [renamingId, setRenamingId] = useState<number | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [dupes, setDupes] = useState<DupeState>({ running: false, stage: null, done: 0, total: 0 })
  const [analysis, setAnalysis] = useState<{ running: boolean; done: number; total: number }>({ running: false, done: 0, total: 0 })
  const noticeTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  // Files being dragged out of the list, so a drop on a collection knows what it got.
  const dragIds = useRef<number[] | null>(null)
  const [view, setView] = useState<View>({})
  const [sort, setSort] = useState<{ field: SortField; desc: boolean }>({ field: 'dateAdded', desc: true })
  const [filters, setFilters] = useState<Filters>(NO_FILTERS)
  const [search, setSearch] = useState('')
  const searchBox = useRef<HTMLInputElement>(null)
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
    window.api.listCollections().then(setCollections)
    setVersion((v) => v + 1)
  }, [])

  const flash = (text: string): void => {
    setNotice(text)
    clearTimeout(noticeTimer.current)
    noticeTimer.current = setTimeout(() => setNotice(null), 3000)
  }

  // Changes made from the native file menu.
  useEffect(
    () =>
      window.api.onLibraryChanged((d) => {
        refreshLibrary()
        if (d.renameCollectionId != null) setRenamingId(d.renameCollectionId)
        if (d.notice) flash(d.notice)
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [refreshLibrary]
  )

  // Background tempo/key detection (runs after duplicate checking). Detected values appear
  // in the list as they come in, refreshed every few seconds rather than per file.
  useEffect(() => {
    window.api.isAnalyzing().then((running) => setAnalysis((a) => ({ ...a, running })))
    let last = 0
    return window.api.onAnalysisEvent((e) => {
      if (e.type === 'progress') {
        setAnalysis({ running: true, done: e.done, total: e.total })
        if (Date.now() - last > 3000) {
          last = Date.now()
          refreshLibrary()
        }
      } else {
        setAnalysis({ running: false, done: 0, total: 0 })
        refreshLibrary()
      }
    })
  }, [refreshLibrary])

  // Background duplicate checking (runs after every scan).
  useEffect(() => {
    window.api.isCheckingDuplicates().then((running) => setDupes((d) => ({ ...d, running })))
    return window.api.onDupeEvent((e) => {
      if (e.type === 'progress') setDupes({ running: true, stage: e.stage, done: e.done, total: e.total })
      else {
        setDupes({ running: false, stage: null, done: 0, total: 0 })
        refreshLibrary()
      }
    })
  }, [refreshLibrary])

  useEffect(() => {
    const clear = (): void => void (dragIds.current = null)
    window.addEventListener('mousedown', clear)
    return () => window.removeEventListener('mousedown', clear)
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

  // Search the library a moment after typing pauses, not on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setFilters((f) => (f.search === search ? f : { ...f, search })), 150)
    return () => clearTimeout(t)
  }, [search])

  const filter = {
    category: view.category,
    subtype: view.subtype,
    rootId: view.rootId,
    favorite: view.favorite,
    tagId: view.tagId,
    collectionId: view.collectionId,
    duplicates: view.duplicates,
    // A collection shows its files even when they've gone missing, so you can see what's lost.
    includeMissing: view.collectionId != null || undefined,
    ...filtersToQuery(filters, filters.search),
    sort: sort.field,
    desc: sort.desc
  }
  const list = useFileList(filter, version)

  const clearSelection = (): void => {
    setFocus(null)
    setSelection(new Set())
    anchor.current = null
  }

  // Row positions mean nothing once the result set changes.
  const filtersKey = JSON.stringify(filters)
  useEffect(clearSelection, [filtersKey])

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

  const changeView = (v: View): void => {
    setView(v)
    clearSelection()
    if (v.collectionId != null) setSort({ field: 'position', desc: false })
    else if (sort.field === 'position') setSort({ field: 'dateAdded', desc: true })
  }

  const dropFiles = async (collectionId: number | null, e: React.DragEvent): Promise<void> => {
    const ids = dragIds.current
    dragIds.current = null
    const files = [...e.dataTransfer.files]
    if (collectionId == null) {
      if (!ids?.length && !files.length) return
      const c = await window.api.createCollection('New Collection', ids ?? [])
      if (!ids?.length) await window.api.addDroppedToCollection(c.id, files)
      setRenamingId(c.id)
      refreshLibrary()
      return
    }
    const name = collections.find((c) => c.id === collectionId)?.name ?? 'collection'
    let added: number
    if (ids?.length) {
      await window.api.addToCollection(collectionId, ids)
      added = ids.length
    } else {
      added = await window.api.addDroppedToCollection(collectionId, files)
    }
    flash(
      added
        ? `Added ${added === 1 ? '1 file' : `${added} files`} to “${name}”`
        : 'Only files already in your library can go in a collection. Add their folder first.'
    )
    refreshLibrary()
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
      const mod = isMac ? e.metaKey : e.ctrlKey
      if (mod && e.code === 'KeyF') {
        e.preventDefault()
        searchBox.current?.focus()
        searchBox.current?.select()
        return
      }
      if (t.closest('input, textarea, select, [contenteditable]')) return
      if (e.key === '/') {
        e.preventDefault()
        searchBox.current?.focus()
        return
      }
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
        dupes={dupes}
        analysis={analysis}
        tags={tags}
        collections={collections}
        renamingId={renamingId}
        view={view}
        scan={scan}
        onView={changeView}
        onNewCollection={async () => {
          const c = await window.api.createCollection('New Collection')
          refreshLibrary()
          setRenamingId(c.id)
        }}
        onRenameStart={setRenamingId}
        onRenameCollection={async (id, name) => {
          await window.api.renameCollection(id, name)
          refreshLibrary()
        }}
        onDeleteCollection={async (c) => {
          const ok = window.confirm(
            `Delete the collection “${c.name}”?\n\nOnly the list is deleted. The ${c.count === 1 ? 'file' : `${c.count} files`} in it stay in your library and on disk.`
          )
          if (!ok) return
          await window.api.deleteCollection(c.id)
          if (view.collectionId === c.id) changeView({})
          refreshLibrary()
        }}
        onDropFiles={dropFiles}
        onAddFolders={() => window.api.addRoots().then(refreshLibrary)}
        onRemoveRoot={async (root) => {
          const ok = window.confirm(
            `Remove "${root.path}" from the library?\n\nYour files on disk are NOT touched. Tags, ratings, notes and collection entries for files in this folder will be forgotten.`
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
          <div className="toolbar-title">{viewTitle(view, roots, tags, collections)}</div>
          <div className="toolbar-count">
            {list.total.toLocaleString()} files
            {selection.size > 1 && <span className="toolbar-sel"> · {selection.size.toLocaleString()} selected</span>}
          </div>
          {notice && <div className="toolbar-notice">{notice}</div>}
          {scan.running && (
            <div className="toolbar-scan">
              <span className="spinner" /> Scanning… {scan.processed.toLocaleString()} / {scan.found.toLocaleString()}
            </div>
          )}
          <SearchBox
            ref={searchBox}
            value={search}
            onChange={setSearch}
            onEnterList={() => {
              const row = list.rowAt(0)
              if (row) selectOne(0, row)
            }}
          />
        </div>
        {view.duplicates && (
          <DupesBar
            stats={counts?.duplicates ?? null}
            state={dupes}
            selected={selection.size}
            onSelectExtra={async () => {
              const ids = await window.api.extraCopyIds(filter)
              setSelection(new Set(ids))
              setFocus(null)
              anchor.current = null
            }}
            onTrash={() => window.api.trashDuplicates([...selection])}
            onCheck={() => window.api.checkDuplicates()}
          />
        )}
        <FilterBar filters={filters} onChange={(f) => setFilters({ ...f, search: filters.search })} />
        <FileTable
          list={list}
          sort={sort}
          onSort={onSort}
          focus={focus}
          selection={selection}
          onRowClick={onRowClick}
          onRate={(row, rating) => edit(targetIds(row), { rating })}
          onFavorite={(row) => edit(targetIds(row), { favorite: !row.favorite })}
          onDragFiles={(ids) => {
            dragIds.current = ids
            window.api.startDrag(ids)
          }}
          onContextMenu={(index, row) => {
            let ids = [...selection]
            if (!selection.has(row.id)) {
              selectOne(index, row, false)
              ids = [row.id]
            }
            window.api.showFileMenu(ids, { collectionId: view.collectionId, duplicates: view.duplicates })
          }}
          groupDuplicates={!!view.duplicates}
          emptyText={
            view.duplicates && !filters.search && !activeFilterCount(filters)
              ? dupes.running
                ? 'Checking for duplicates…'
                : 'No duplicates found. Every sound in your library is there once.'
              : view.collectionId != null && !filters.search && !activeFilterCount(filters)
              ? 'This collection is empty. Drag files onto it in the sidebar, or right-click files › Add to Collection.'
              : filters.search || activeFilterCount(filters)
              ? 'No files match this search and these filters.'
              : 'No files here yet. Add a folder on the left to start indexing.'
          }
        />
      </main>
      <Inspector
        ids={[...selection]}
        version={version}
        allTags={tags}
        allCollections={collections}
        onChanged={refreshLibrary}
        onShowDuplicates={() => changeView({ duplicates: true })}
      />
      <PlayerBar ref={player} version={version} />
    </div>
  )
}

function viewTitle(view: View, roots: Root[], tags: TagInfo[], collections: Collection[]): string {
  if (view.rootId != null) return roots.find((r) => r.id === view.rootId)?.path ?? 'Folder'
  if (view.favorite) return 'Favorites'
  if (view.duplicates) return 'Duplicates'
  if (view.collectionId != null) return collections.find((c) => c.id === view.collectionId)?.name ?? 'Collection'
  if (view.tagId != null) return '# ' + (tags.find((t) => t.id === view.tagId)?.name ?? 'Tag')
  if (view.subtype) return 'Drums › ' + SUBTYPE_LABELS[view.subtype]
  if (view.category) return CATEGORY_LABELS[view.category]
  return 'All Files'
}
