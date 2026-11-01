import { CATEGORIES, CATEGORY_LABELS, DRUM_SUBTYPES, SUBTYPE_LABELS } from '../../shared/types'
import { useEffect, useRef, useState } from 'react'
import type { Collection, LibraryCounts, Root, TagInfo } from '../../shared/types'
import type { DupeState, ScanState, View } from './App'

interface Props {
  roots: Root[]
  counts: LibraryCounts | null
  dupes: DupeState
  analysis: { running: boolean; done: number; total: number }
  tags: TagInfo[]
  collections: Collection[]
  /** Collection whose name is being edited inline (just created, or double-clicked). */
  renamingId: number | null
  view: View
  scan: ScanState
  onView: (v: View) => void
  onAddFolders: () => void
  onRemoveRoot: (root: Root) => void
  onRescan: (rootIds?: number[]) => void
  onNewCollection: () => void
  onRenameStart: (id: number | null) => void
  onRenameCollection: (id: number, name: string) => void
  onDeleteCollection: (c: Collection) => void
  /** Files dropped on a collection (`null` = on "new collection"). */
  onDropFiles: (collectionId: number | null, e: React.DragEvent) => void
}

export function Sidebar(props: Props): React.JSX.Element {
  const { roots, counts, tags, collections, renamingId, view, scan, onView, onAddFolders, onRemoveRoot, onRescan } = props
  const [dropOver, setDropOver] = useState<number | 'new' | null>(null)

  // Accept files dragged from the list (or from Explorer/Finder) onto a collection.
  const dropProps = (target: number | 'new'): React.HTMLAttributes<HTMLElement> => ({
    onDragOver: (e) => {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'link'
      if (dropOver !== target) setDropOver(target)
    },
    onDragLeave: () => setDropOver((d) => (d === target ? null : d)),
    onDrop: (e) => {
      e.preventDefault()
      setDropOver(null)
      props.onDropFiles(target === 'new' ? null : target, e)
    }
  })

  const isActive = (v: View): boolean =>
    v.category === view.category &&
    v.subtype === view.subtype &&
    v.rootId === view.rootId &&
    v.favorite === view.favorite &&
    v.tagId === view.tagId &&
    v.collectionId === view.collectionId &&
    v.duplicates === view.duplicates

  const item = (label: string, v: View, count?: number, indent = false): React.JSX.Element => (
    <button
      key={label}
      className={`side-item${isActive(v) ? ' active' : ''}${indent ? ' indent' : ''}`}
      onClick={() => onView(v)}
    >
      <span className="side-label">{label}</span>
      {count != null && <span className="side-count">{count.toLocaleString()}</span>}
    </button>
  )

  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark" /> Sample Manager
      </div>

      <div className="side-section">
        <div className="side-heading">Library</div>
        {item('All Files', {}, counts?.total)}
        {CATEGORIES.map((c) => (
          <div key={c}>
            {item(CATEGORY_LABELS[c], { category: c }, counts?.byCategory[c])}
            {c === 'drum' &&
              view.category === 'drum' &&
              DRUM_SUBTYPES.map((s) => item(SUBTYPE_LABELS[s], { category: 'drum', subtype: s }, counts?.bySubtype[s], true))}
          </div>
        ))}
        {item('♥  Favorites', { favorite: true }, counts?.favorites)}
        {item(props.dupes.running ? '⧉  Duplicates…' : '⧉  Duplicates', { duplicates: true }, counts?.duplicates.extra)}
      </div>

      <div className="side-section">
        <div className={`side-heading${dropOver === 'new' ? ' drop-over' : ''}`} {...dropProps('new')}>
          Collections
          <button className="icon-btn" title="New collection (or drop files here)" onClick={props.onNewCollection}>
            +
          </button>
        </div>
        {collections.length === 0 && (
          <div className={`side-empty small${dropOver === 'new' ? ' drop-over' : ''}`} {...dropProps('new')}>
            Group files for a project or kit. Nothing is copied. Drop files here or right-click them.
          </div>
        )}
        {collections.map((c) =>
          renamingId === c.id ? (
            <RenameBox
              key={c.id}
              name={c.name}
              onDone={(name) => {
                if (name != null) props.onRenameCollection(c.id, name)
                props.onRenameStart(null)
              }}
            />
          ) : (
            <div
              key={c.id}
              className={`root-row coll-row${view.collectionId === c.id ? ' active' : ''}${dropOver === c.id ? ' drop-over' : ''}`}
              {...dropProps(c.id)}
            >
              <button
                className="root-main"
                title="Double-click to rename"
                onClick={() => onView({ collectionId: c.id })}
                onDoubleClick={() => props.onRenameStart(c.id)}
              >
                <span className="coll-icon">▤</span>
                <span className="side-label">{c.name}</span>
                <span className="side-count">{c.count.toLocaleString()}</span>
              </button>
              <button className="icon-btn subtle" title="Delete collection (files are kept)" onClick={() => props.onDeleteCollection(c)}>
                ×
              </button>
            </div>
          )
        )}
      </div>

      {tags.length > 0 && (
        <div className="side-section">
          <div className="side-heading">Tags</div>
          <div className="side-tags">
            {tags.map((t) => (
              <button
                key={t.id}
                className={`side-tag${view.tagId === t.id ? ' active' : ''}`}
                title={`${t.count.toLocaleString()} files`}
                onClick={() => onView(view.tagId === t.id ? {} : { tagId: t.id })}
              >
                {t.name}
                <span className="side-count">{t.count.toLocaleString()}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="side-section">
        <div className="side-heading">
          Folders
          <button className="icon-btn" title="Add folders" onClick={onAddFolders}>
            +
          </button>
        </div>
        {roots.length === 0 && (
          <div className="side-empty">
            No folders yet.
            <button className="btn primary" onClick={onAddFolders}>
              Add a folder
            </button>
          </div>
        )}
        {roots.map((r) => (
          <div key={r.id} className={`root-row${view.rootId === r.id ? ' active' : ''}`}>
            <button className="root-main" onClick={() => onView({ rootId: r.id })} title={r.path}>
              <span className={`dot ${r.status}`} />
              <span className="side-label">{shortPath(r.path)}</span>
              <span className="side-count">{r.fileCount.toLocaleString()}</span>
            </button>
            <button className="icon-btn subtle" title="Rescan this folder" onClick={() => onRescan([r.id])} disabled={scan.running}>
              ↻
            </button>
            <button className="icon-btn subtle" title="Remove from library (files stay on disk)" onClick={() => onRemoveRoot(r)}>
              ×
            </button>
          </div>
        ))}
        {roots.length > 0 && (
          <button className="btn" onClick={() => onRescan()} disabled={scan.running}>
            {scan.running ? 'Scanning…' : 'Rescan all'}
          </button>
        )}
      </div>

      <div className="side-footer">
        {scan.running ? (
          <>
            <div className="scan-path" title={scan.rootPath}>
              {shortPath(scan.rootPath)}
            </div>
            <div className="progress">
              <div className="progress-bar" style={{ width: scan.found ? `${(scan.processed / scan.found) * 100}%` : '0%' }} />
            </div>
          </>
        ) : (
          scan.message && <div className="scan-msg">{scan.message}</div>
        )}
        {!scan.running && props.dupes.running && (
          <div className="scan-msg">
            Checking for duplicates
            {props.dupes.total > 0 && ` · ${Math.round((props.dupes.done / props.dupes.total) * 100)}%`}
          </div>
        )}
        {!scan.running && !props.dupes.running && props.analysis.running && props.analysis.total > 0 && (
          <div className="scan-msg" title="Listening to new files for tempo and key. Only fills in what the file names don't say.">
            Detecting BPM & key · {props.analysis.done.toLocaleString()} / {props.analysis.total.toLocaleString()}
          </div>
        )}
        {counts && counts.missing > 0 && <div className="scan-msg warn">{counts.missing.toLocaleString()} files missing</div>}
      </div>
    </aside>
  )
}

function shortPath(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts.length <= 2 ? p : '…/' + parts.slice(-2).join('/')
}

function RenameBox({ name, onDone }: { name: string; onDone: (name: string | null) => void }): React.JSX.Element {
  const [text, setText] = useState(name)
  const input = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  const finish = (value: string | null): void => {
    if (done.current) return
    done.current = true
    onDone(value)
  }
  useEffect(() => input.current?.select(), [])
  return (
    <input
      ref={input}
      autoFocus
      className="input rename-input"
      value={text}
      maxLength={80}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') finish(text)
        if (e.key === 'Escape') finish(null)
      }}
      onBlur={() => finish(text)}
    />
  )
}
