// Right-hand panel: details and editing for the selected file, or batch edits for a multi-selection.
// Edits only change the library index; the audio files themselves are never written.

import { useEffect, useRef, useState } from 'react'
import { CATEGORIES, CATEGORY_SHORT, DRUM_SUBTYPES, MUSICAL_KEYS, SUBTYPE_LABELS } from '../../shared/types'
import type { Collection, DrumSubtype, FilePatch, FileRow, TagInfo, ValueSource } from '../../shared/types'
import { formatBpm, formatDate, formatDuration, formatSize, stripExt } from './format'
import { Stars } from './Stars'

const SOURCE_LABEL: Record<ValueSource, string> = {
  auto: 'auto',
  filename: 'from name',
  tag: 'from tag',
  analysis: 'detected',
  manual: 'manual'
}

interface Props {
  ids: number[]
  version: number
  allTags: TagInfo[]
  allCollections: Collection[]
  /** Called after any edit so the list, counts and tags refresh. */
  onChanged: () => void
  onShowDuplicates: () => void
}

export function Inspector({ ids, version, allTags, allCollections, onChanged, onShowDuplicates }: Props): React.JSX.Element {
  if (ids.length === 0) {
    return (
      <aside className="inspector">
        <div className="inspector-empty">Select a file to see its details.</div>
      </aside>
    )
  }
  return (
    <aside className="inspector">
      {ids.length === 1 ? (
        <SingleFile
          id={ids[0]}
          version={version}
          allTags={allTags}
          allCollections={allCollections}
          onChanged={onChanged}
          onShowDuplicates={onShowDuplicates}
        />
      ) : (
        <MultiFile
          ids={ids}
          version={version}
          allTags={allTags}
          allCollections={allCollections}
          onChanged={onChanged}
          onShowDuplicates={onShowDuplicates}
        />
      )}
    </aside>
  )
}

function SingleFile({ id, version, allTags, allCollections, onChanged, onShowDuplicates }: { id: number } & Omit<Props, 'ids'>): React.JSX.Element | null {
  const [file, setFile] = useState<FileRow | null>(null)

  useEffect(() => {
    let live = true
    window.api.getFile(id).then((f) => live && setFile(f))
    return () => {
      live = false
    }
  }, [id, version])

  if (!file || file.id !== id) return null

  const edit = async (patch: FilePatch): Promise<void> => {
    await window.api.updateFiles([file.id], patch)
    onChanged()
  }
  const channels = file.channels === 1 ? 'Mono' : file.channels === 2 ? 'Stereo' : file.channels ? String(file.channels) : '—'

  return (
    <>
      <div className="insp-title">{stripExt(file.name)}</div>
      <div className="insp-path" title={file.path}>
        {file.path}
      </div>
      {file.status !== 'ok' && (
        <div className="insp-warn">{file.status === 'missing' ? 'File not found at this path.' : 'Folder is offline.'}</div>
      )}

      {file.dupCount > 0 && <DuplicateNote id={file.id} version={version} onShow={onShowDuplicates} />}

      <div className="insp-rate">
        <Stars value={file.rating} onChange={(rating) => edit({ rating })} />
        <button
          className={`fav-btn${file.favorite ? ' on' : ''}`}
          title={file.favorite ? 'Remove from favorites (F)' : 'Add to favorites (F)'}
          onClick={() => edit({ favorite: !file.favorite })}
        >
          ♥
        </button>
      </div>

      <div className="insp-group">
        <Field label="Category" source={file.categorySource}>
          <CategoryPicker value={file.category} onPick={(category) => edit({ category })} />
        </Field>
        {file.category === 'drum' && (
          <Field label="Type" source={file.subtype ? file.subtypeSource : null}>
            <SubtypeSelect value={file.subtype} onPick={(subtype) => edit({ subtype })} />
          </Field>
        )}
        <Field label="BPM" source={file.bpmSource}>
          <BpmInput value={file.bpm} onCommit={(bpm) => edit({ bpm })} />
        </Field>
        <Field label="Key" source={file.keySource}>
          <KeySelect value={file.key} onPick={(key) => edit({ key })} />
        </Field>
      </div>

      <div className="insp-group">
        <div className="insp-label">Tags</div>
        <TagEditor
          tags={file.tags.map((name) => ({ name, partial: false }))}
          allTags={allTags}
          onAdd={async (names) => {
            await window.api.addTags([file.id], names)
            onChanged()
          }}
          onRemove={async (name) => {
            await window.api.removeTags([file.id], [name])
            onChanged()
          }}
        />
      </div>

      <div className="insp-group">
        <div className="insp-label">Collections</div>
        <CollectionEditor ids={[file.id]} version={version} allCollections={allCollections} onChanged={onChanged} />
      </div>

      <div className="insp-group">
        <div className="insp-label">Notes</div>
        <NotesEditor key={file.id} value={file.notes} onSave={(notes) => edit({ notes })} />
      </div>

      <div className="insp-group">
        <ReadOnly label="Length" value={formatDuration(file.durationMs)} />
        <ReadOnly label="Sample rate" value={file.sampleRate ? `${(file.sampleRate / 1000).toFixed(1)} kHz` : '—'} />
        <ReadOnly label="Bit depth" value={file.bitDepth ? `${file.bitDepth}-bit` : '—'} />
        <ReadOnly label="Channels" value={channels} />
        <ReadOnly label="Format" value={file.ext.toUpperCase()} />
        <ReadOnly label="Size" value={formatSize(file.size)} />
        <ReadOnly label="Added" value={formatDate(file.dateAdded)} />
      </div>
      <button className="btn" onClick={() => window.api.revealFile(file.id)}>
        Show in folder
      </button>
    </>
  )
}

function MultiFile({ ids, version, allTags, allCollections, onChanged }: Omit<Props, 'ids'> & { ids: number[] }): React.JSX.Element {
  const [tags, setTags] = useState<TagInfo[]>([])
  const idsKey = ids.join(',')

  useEffect(() => {
    let live = true
    window.api.tagsForFiles(ids).then((t) => live && setTags(t))
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, version])

  const edit = async (patch: FilePatch): Promise<void> => {
    await window.api.updateFiles(ids, patch)
    onChanged()
  }

  return (
    <>
      <div className="insp-title">{ids.length.toLocaleString()} files selected</div>
      <div className="insp-hint">Changes apply to every selected file.</div>

      <div className="insp-rate">
        <Stars value={0} onChange={(rating) => edit({ rating })} />
        <button className="fav-btn on" title="Add all to favorites" onClick={() => edit({ favorite: true })}>
          ♥
        </button>
        <button className="link-btn" onClick={() => edit({ favorite: false })}>
          Unfavorite
        </button>
      </div>

      <div className="insp-group">
        <Field label="Category">
          <CategoryPicker value={null} onPick={(category) => edit({ category })} />
        </Field>
        <Field label="Type">
          <SubtypeSelect value={undefined} onPick={(subtype) => edit({ subtype })} />
        </Field>
        <Field label="BPM">
          <BpmInput value={undefined} onCommit={(bpm) => edit({ bpm })} />
        </Field>
        <Field label="Key">
          <KeySelect value={undefined} onPick={(key) => edit({ key })} />
        </Field>
      </div>

      <div className="insp-group">
        <div className="insp-label">Tags</div>
        <TagEditor
          tags={tags.map((t) => ({ name: t.name, partial: t.count < ids.length, count: t.count }))}
          allTags={allTags}
          onAdd={async (names) => {
            await window.api.addTags(ids, names)
            onChanged()
          }}
          onRemove={async (name) => {
            await window.api.removeTags(ids, [name])
            onChanged()
          }}
        />
      </div>

      <div className="insp-group">
        <div className="insp-label">Collections</div>
        <CollectionEditor ids={ids} version={version} allCollections={allCollections} onChanged={onChanged} />
      </div>
    </>
  )
}

// ---------- pieces ----------

function Field({ label, source, children }: { label: string; source?: ValueSource | null; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="field">
      <div className="k">
        {label}
        {source && <span className={`src${source === 'manual' ? ' manual' : ''}`}>{SOURCE_LABEL[source]}</span>}
      </div>
      <div className="field-input">{children}</div>
    </div>
  )
}

function ReadOnly({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="kv">
      <div className="k">{label}</div>
      <div className="v">{value}</div>
    </div>
  )
}

function CategoryPicker({ value, onPick }: { value: FileRow['category'] | null; onPick: (c: FileRow['category']) => void }): React.JSX.Element {
  return (
    <div className="seg">
      {CATEGORIES.map((c) => (
        <button key={c} className={`cat-${c}${value === c ? ' on' : ''}`} onClick={() => value !== c && onPick(c)}>
          {CATEGORY_SHORT[c]}
        </button>
      ))}
    </div>
  )
}

/** `undefined` = mixed selection (nothing chosen yet). */
function SubtypeSelect({ value, onPick }: { value: DrumSubtype | null | undefined; onPick: (s: DrumSubtype | null) => void }): React.JSX.Element {
  return (
    <select
      className="input"
      value={value === undefined ? '__keep' : (value ?? '')}
      onChange={(e) => e.target.value !== '__keep' && onPick((e.target.value || null) as DrumSubtype | null)}
    >
      {value === undefined && <option value="__keep">Keep as is</option>}
      <option value="">—</option>
      {DRUM_SUBTYPES.map((s) => (
        <option key={s} value={s}>
          {SUBTYPE_LABELS[s]}
        </option>
      ))}
    </select>
  )
}

function KeySelect({ value, onPick }: { value: string | null | undefined; onPick: (k: string | null) => void }): React.JSX.Element {
  return (
    <select
      className="input"
      value={value === undefined ? '__keep' : (value ?? '')}
      onChange={(e) => e.target.value !== '__keep' && onPick(e.target.value || null)}
    >
      {value === undefined && <option value="__keep">Keep as is</option>}
      <option value="">—</option>
      {MUSICAL_KEYS.map((k) => (
        <option key={k} value={k}>
          {k.endsWith('m') ? `${k.slice(0, -1)} minor` : `${k} major`}
        </option>
      ))}
    </select>
  )
}

/** Commits on Enter or blur; Esc reverts. Empty clears the BPM. */
function BpmInput({ value, onCommit }: { value: number | null | undefined; onCommit: (bpm: number | null) => void }): React.JSX.Element {
  const shown = value == null ? '' : formatBpm(value)
  const [text, setText] = useState(shown)
  useEffect(() => setText(shown), [shown])

  const commit = (): void => {
    const t = text.trim()
    if (t === shown) return
    if (t === '') {
      if (value !== undefined) onCommit(null)
      return
    }
    const n = Number(t.replace(',', '.'))
    if (Number.isFinite(n) && n >= 20 && n <= 999) onCommit(n)
    else setText(shown)
  }

  return (
    <input
      className="input"
      inputMode="decimal"
      placeholder={value === undefined ? 'Keep as is' : '—'}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') {
          setText(shown)
          setTimeout(() => (e.target as HTMLInputElement).blur())
        }
      }}
    />
  )
}

/** Saves a moment after typing stops, and when the box loses focus or the file changes. */
function NotesEditor({ value, onSave }: { value: string; onSave: (notes: string) => void }): React.JSX.Element {
  const [text, setText] = useState(value)
  const saved = useRef(value)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const latest = useRef({ text, onSave })
  latest.current = { text, onSave }

  const flush = (): void => {
    clearTimeout(timer.current)
    const { text: t, onSave: save } = latest.current
    if (t !== saved.current) {
      saved.current = t
      save(t)
    }
  }
  // Flush on unmount (switching to another file).
  useEffect(() => flush, [])

  return (
    <textarea
      className="input notes"
      rows={4}
      placeholder="Where it's from, what it's good for…"
      value={text}
      onChange={(e) => {
        setText(e.target.value)
        clearTimeout(timer.current)
        timer.current = setTimeout(flush, 800)
      }}
      onBlur={flush}
    />
  )
}

/** "Same audio as" list for a file that has exact copies elsewhere. */
function DuplicateNote({ id, version, onShow }: { id: number; version: number; onShow: () => void }): React.JSX.Element {
  const [copies, setCopies] = useState<FileRow[]>([])
  useEffect(() => {
    let live = true
    window.api.duplicatesOf(id).then((c) => live && setCopies(c))
    return () => {
      live = false
    }
  }, [id, version])
  return (
    <div className="insp-dupe">
      <div className="insp-dupe-head">
        ⧉ Same audio as {copies.length === 1 ? '1 other file' : `${copies.length} other files`}
        <button className="link-btn" onClick={onShow}>
          Review
        </button>
      </div>
      {copies.slice(0, 5).map((c) => (
        <button key={c.id} className="insp-dupe-path" title={`${c.path}\nClick to show in folder`} onClick={() => window.api.revealFile(c.id)}>
          {/* The end of the path is what tells copies apart. */}
          …/{c.path.split(/[\\/]/).slice(-3).join('/')}
        </button>
      ))}
      {copies.length > 5 && <div className="insp-dupe-more">…and {copies.length - 5} more</div>}
    </div>
  )
}

/** Which collections the selection is in, with remove buttons and an "add to" picker. */
function CollectionEditor({
  ids,
  version,
  allCollections,
  onChanged
}: {
  ids: number[]
  version: number
  allCollections: Collection[]
  onChanged: () => void
}): React.JSX.Element {
  const [inside, setInside] = useState<Collection[]>([])
  const idsKey = ids.join(',')

  useEffect(() => {
    let live = true
    window.api.collectionsForFiles(ids).then((c) => live && setInside(c))
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, version])

  const full = new Set(inside.filter((c) => c.count === ids.length).map((c) => c.id))
  const addable = allCollections.filter((c) => !full.has(c.id))

  return (
    <div className="tags">
      {inside.map((c) => {
        const partial = c.count < ids.length
        return (
          <span key={c.id} className={`chip coll${partial ? ' partial' : ''}`} title={partial ? `${c.count} of the selected files` : undefined}>
            ▤ {c.name}
            {partial && <span className="chip-count">{c.count}</span>}
            <button
              title="Remove from this collection (the file stays in your library)"
              onClick={async () => {
                await window.api.removeFromCollection(c.id, ids)
                onChanged()
              }}
            >
              ×
            </button>
          </span>
        )
      })}
      <select
        className="input"
        value=""
        onChange={async (e) => {
          const v = e.target.value
          if (v === 'new') await window.api.createCollection('New Collection', ids)
          else if (v) await window.api.addToCollection(Number(v), ids)
          onChanged()
        }}
      >
        <option value="">Add to collection…</option>
        {addable.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
        <option value="new">+ New collection</option>
      </select>
    </div>
  )
}

interface ChipTag {
  name: string
  /** Only some of the selected files have it. */
  partial: boolean
  count?: number
}

function TagEditor({
  tags,
  allTags,
  onAdd,
  onRemove
}: {
  tags: ChipTag[]
  allTags: TagInfo[]
  onAdd: (names: string[]) => void
  onRemove: (name: string) => void
}): React.JSX.Element {
  const [text, setText] = useState('')
  const have = new Set(tags.filter((t) => !t.partial).map((t) => t.name.toLowerCase()))
  const suggestions = allTags.filter((t) => !have.has(t.name.toLowerCase()))

  const submit = (): void => {
    const names = text
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    if (names.length) onAdd(names)
    setText('')
  }

  return (
    <div className="tags">
      {tags.map((t) => (
        <span key={t.name} className={`chip${t.partial ? ' partial' : ''}`} title={t.partial ? `On ${t.count} of the selected files` : undefined}>
          {t.name}
          {t.partial && <span className="chip-count">{t.count}</span>}
          {t.partial && (
            <button title="Add to all selected" onClick={() => onAdd([t.name])}>
              +
            </button>
          )}
          <button title="Remove tag" onClick={() => onRemove(t.name)}>
            ×
          </button>
        </span>
      ))}
      <input
        className="input tag-input"
        list="tag-suggestions"
        placeholder="Add tag…"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault()
            submit()
          } else if (e.key === 'Backspace' && !text && tags.length && !tags[tags.length - 1].partial) {
            onRemove(tags[tags.length - 1].name)
          } else if (e.key === 'Escape') {
            setText('')
            ;(e.target as HTMLInputElement).blur()
          }
        }}
        onBlur={() => text.trim() && submit()}
      />
      <datalist id="tag-suggestions">
        {suggestions.map((t) => (
          <option key={t.id} value={t.name} />
        ))}
      </datalist>
    </div>
  )
}
