import { useCallback, useEffect, useRef, useState } from 'react'
import type { Category, DrumSubtype, LibraryCounts, Root, ScanEvent, SortField } from '../../shared/types'
import { CATEGORY_LABELS, SUBTYPE_LABELS } from '../../shared/types'
import { FileTable } from './FileTable'
import { Inspector } from './Inspector'
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
}

export function App(): React.JSX.Element {
  const [roots, setRoots] = useState<Root[]>([])
  const [counts, setCounts] = useState<LibraryCounts | null>(null)
  const [view, setView] = useState<View>({})
  const [sort, setSort] = useState<{ field: SortField; desc: boolean }>({ field: 'dateAdded', desc: true })
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [version, setVersion] = useState(0)
  const [scan, setScan] = useState<ScanState>({ running: false, rootPath: '', found: 0, processed: 0, message: '' })
  const lastRefresh = useRef(0)

  const refreshLibrary = useCallback(() => {
    window.api.listRoots().then(setRoots)
    window.api.counts().then(setCounts)
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

  const list = useFileList(
    { category: view.category, subtype: view.subtype, rootId: view.rootId, sort: sort.field, desc: sort.desc },
    version
  )

  const onSort = (field: SortField): void =>
    setSort((s) => (s.field === field ? { field, desc: !s.desc } : { field, desc: field === 'dateAdded' || field === 'size' }))

  return (
    <div className="app">
      <Sidebar
        roots={roots}
        counts={counts}
        view={view}
        scan={scan}
        onView={(v) => {
          setView(v)
          setSelectedId(null)
        }}
        onAddFolders={() => window.api.addRoots().then(refreshLibrary)}
        onRemoveRoot={async (root) => {
          const ok = window.confirm(
            `Remove "${root.path}" from the library?\n\nYour files on disk are NOT touched. Tags, ratings and notes for files in this folder will be forgotten.`
          )
          if (!ok) return
          await window.api.removeRoot(root.id)
          if (view.rootId === root.id) setView({})
          refreshLibrary()
        }}
        onRescan={(rootIds) => window.api.startScan(rootIds)}
      />
      <main className="main">
        <div className="toolbar">
          <div className="toolbar-title">{viewTitle(view, roots)}</div>
          <div className="toolbar-count">{list.total.toLocaleString()} files</div>
          {scan.running && (
            <div className="toolbar-scan">
              <span className="spinner" /> Scanning… {scan.processed.toLocaleString()} / {scan.found.toLocaleString()}
            </div>
          )}
        </div>
        <FileTable list={list} sort={sort} onSort={onSort} selectedId={selectedId} onSelect={setSelectedId} />
      </main>
      <Inspector fileId={selectedId} version={version} />
    </div>
  )
}

function viewTitle(view: View, roots: Root[]): string {
  if (view.rootId != null) return roots.find((r) => r.id === view.rootId)?.path ?? 'Folder'
  if (view.subtype) return 'Drums › ' + SUBTYPE_LABELS[view.subtype]
  if (view.category) return CATEGORY_LABELS[view.category]
  return 'All Files'
}
