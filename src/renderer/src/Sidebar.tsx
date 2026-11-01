import { CATEGORIES, CATEGORY_LABELS, DRUM_SUBTYPES, SUBTYPE_LABELS } from '../../shared/types'
import type { LibraryCounts, Root, TagInfo } from '../../shared/types'
import type { ScanState, View } from './App'

interface Props {
  roots: Root[]
  counts: LibraryCounts | null
  tags: TagInfo[]
  view: View
  scan: ScanState
  onView: (v: View) => void
  onAddFolders: () => void
  onRemoveRoot: (root: Root) => void
  onRescan: (rootIds?: number[]) => void
}

export function Sidebar({ roots, counts, tags, view, scan, onView, onAddFolders, onRemoveRoot, onRescan }: Props): React.JSX.Element {
  const isActive = (v: View): boolean =>
    v.category === view.category &&
    v.subtype === view.subtype &&
    v.rootId === view.rootId &&
    v.favorite === view.favorite &&
    v.tagId === view.tagId

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
        {counts && counts.missing > 0 && <div className="scan-msg warn">{counts.missing.toLocaleString()} files missing</div>}
      </div>
    </aside>
  )
}

function shortPath(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts.length <= 2 ? p : '…/' + parts.slice(-2).join('/')
}
