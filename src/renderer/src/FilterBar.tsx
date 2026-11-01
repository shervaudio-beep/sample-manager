// Search box and the filter row under the toolbar: BPM range, key, rating, length and format.
// Filters stack on top of whatever the sidebar shows.

import { forwardRef, useEffect, useRef, useState } from 'react'
import { camelot, compatibleKeys } from '../../shared/keys'
import { MUSICAL_KEYS } from '../../shared/types'
import type { FileQuery } from '../../shared/types'
import { Stars } from './Stars'

export type LengthFilter = 'any' | 'oneshot' | 'loop' | 'long'

export interface Filters {
  search: string
  bpmMin: number | null
  bpmMax: number | null
  bpmHalfDouble: boolean
  keys: string[]
  minRating: number
  length: LengthFilter
  formats: string[]
}

export const NO_FILTERS: Filters = {
  search: '',
  bpmMin: null,
  bpmMax: null,
  bpmHalfDouble: false,
  keys: [],
  minRating: 0,
  length: 'any',
  formats: []
}

const LENGTHS: Array<{ id: LengthFilter; label: string; title: string; min?: number; max?: number }> = [
  { id: 'any', label: 'Any', title: 'Any length' },
  { id: 'oneshot', label: 'One-shot', title: 'Shorter than 2 seconds', max: 2000 },
  { id: 'loop', label: 'Loop', title: '2 to 30 seconds', min: 2000, max: 30_000 },
  { id: 'long', label: 'Long', title: '30 seconds or longer', min: 30_000 }
]

const FORMATS: Array<{ label: string; exts: string[] }> = [
  { label: 'WAV', exts: ['wav'] },
  { label: 'AIFF', exts: ['aif', 'aiff'] },
  { label: 'MP3', exts: ['mp3'] },
  { label: 'FLAC', exts: ['flac'] },
  { label: 'OGG', exts: ['ogg'] },
  { label: 'M4A', exts: ['m4a'] }
]

/** The part of a FileQuery the filters control. */
export function filtersToQuery(f: Filters, search: string): Partial<FileQuery> {
  const len = LENGTHS.find((l) => l.id === f.length)!
  return {
    search: search.trim() || undefined,
    bpmMin: f.bpmMin ?? undefined,
    bpmMax: f.bpmMax ?? undefined,
    bpmHalfDouble: f.bpmHalfDouble || undefined,
    keys: f.keys.length ? f.keys : undefined,
    minRating: f.minRating || undefined,
    durationMin: len.min,
    durationMax: len.max,
    exts: f.formats.length ? FORMATS.filter((x) => f.formats.includes(x.label)).flatMap((x) => x.exts) : undefined
  }
}

/** How many filters (not counting the search box) are narrowing the list. */
export function activeFilterCount(f: Filters): number {
  return (
    Number(f.bpmMin != null || f.bpmMax != null) +
    Number(f.keys.length > 0) +
    Number(f.minRating > 0) +
    Number(f.length !== 'any') +
    Number(f.formats.length > 0)
  )
}

interface SearchProps {
  value: string
  onChange: (v: string) => void
  /** Down arrow or Enter: jump into the results. */
  onEnterList: () => void
}

export const SearchBox = forwardRef<HTMLInputElement, SearchProps>(function SearchBox({ value, onChange, onEnterList }, ref) {
  return (
    <div className="search">
      <span className="search-icon">⌕</span>
      <input
        ref={ref}
        className="search-input"
        placeholder="Search names, folders, tags, notes…"
        title={'Every word must match. "Quotes" keep words together, -word excludes. Ctrl+F or / to focus.'}
        value={value}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            if (value) onChange('')
            else e.currentTarget.blur()
          } else if (e.key === 'ArrowDown' || e.key === 'Enter') {
            e.preventDefault()
            e.currentTarget.blur()
            onEnterList()
          }
        }}
      />
      {value && (
        <button className="search-clear" title="Clear search (Esc)" onClick={() => onChange('')}>
          ×
        </button>
      )}
    </div>
  )
})

interface BarProps {
  filters: Filters
  onChange: (f: Filters) => void
}

export function FilterBar({ filters: f, onChange }: BarProps): React.JSX.Element {
  const set = (patch: Partial<Filters>): void => onChange({ ...f, ...patch })
  const active = activeFilterCount(f)

  return (
    <div className="filterbar">
      <div className={`fgroup${f.bpmMin != null || f.bpmMax != null ? ' active' : ''}`}>
        <span className="flabel">BPM</span>
        <NumberBox value={f.bpmMin} placeholder="min" onCommit={(bpmMin) => set({ bpmMin })} />
        <span className="fdash">–</span>
        <NumberBox value={f.bpmMax} placeholder="max" onCommit={(bpmMax) => set({ bpmMax })} />
        <button
          className={`ftoggle${f.bpmHalfDouble ? ' on' : ''}`}
          title="Also match half and double time (70 or 280 for a 140 search)"
          onClick={() => set({ bpmHalfDouble: !f.bpmHalfDouble })}
        >
          ½×2
        </button>
      </div>

      <KeyPicker keys={f.keys} onChange={(keys) => set({ keys })} />

      <div className={`fgroup${f.minRating ? ' active' : ''}`} title="Minimum rating">
        <span className="flabel">Rating ≥</span>
        <Stars value={f.minRating} onChange={(minRating) => set({ minRating })} />
      </div>

      <div className={`fgroup${f.length !== 'any' ? ' active' : ''}`}>
        <span className="flabel">Length</span>
        <div className="fseg">
          {LENGTHS.map((l) => (
            <button key={l.id} title={l.title} className={f.length === l.id ? 'on' : ''} onClick={() => set({ length: l.id })}>
              {l.label}
            </button>
          ))}
        </div>
      </div>

      <div className={`fgroup${f.formats.length ? ' active' : ''}`}>
        <div className="fseg">
          {FORMATS.map((x) => {
            const on = f.formats.includes(x.label)
            return (
              <button
                key={x.label}
                className={on ? 'on' : ''}
                onClick={() => set({ formats: on ? f.formats.filter((v) => v !== x.label) : [...f.formats, x.label] })}
              >
                {x.label}
              </button>
            )
          })}
        </div>
      </div>

      {active > 0 && (
        <button className="fclear" onClick={() => onChange({ ...NO_FILTERS, search: f.search })}>
          Clear {active > 1 ? `${active} filters` : 'filter'}
        </button>
      )}
    </div>
  )
}

/** Commits on Enter or blur; empty means no limit. */
function NumberBox({ value, placeholder, onCommit }: { value: number | null; placeholder: string; onCommit: (v: number | null) => void }): React.JSX.Element {
  const shown = value == null ? '' : String(value)
  const [text, setText] = useState(shown)
  useEffect(() => setText(shown), [shown])
  const commit = (): void => {
    const t = text.trim()
    if (t === shown) return
    const n = Number(t)
    if (t === '') onCommit(null)
    else if (Number.isFinite(n) && n > 0 && n < 1000) onCommit(n)
    else setText(shown)
  }
  return (
    <input
      className="fnum"
      inputMode="decimal"
      placeholder={placeholder}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
    />
  )
}

function KeyPicker({ keys, onChange }: { keys: string[]; onChange: (k: string[]) => void }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent): void => {
      if (!box.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  const toggle = (k: string): void => onChange(keys.includes(k) ? keys.filter((x) => x !== k) : [...keys, k])
  const label = keys.length === 0 ? 'Any' : keys.length <= 3 ? keys.join(' ') : `${keys.slice(0, 2).join(' ')} +${keys.length - 2}`
  const majors = MUSICAL_KEYS.filter((k) => !k.endsWith('m'))
  const minors = MUSICAL_KEYS.filter((k) => k.endsWith('m'))

  return (
    <div className={`fgroup key-picker${keys.length ? ' active' : ''}`} ref={box}>
      <button className="fbtn" onClick={() => setOpen((o) => !o)}>
        <span className="flabel">Key</span> {label} <span className="caret">▾</span>
      </button>
      {open && (
        <div className="popover">
          {[majors, minors].map((row, i) => (
            <div key={i} className="key-row">
              {row.map((k) => (
                <button key={k} className={keys.includes(k) ? 'on' : ''} title={`${k.endsWith('m') ? k.slice(0, -1) + ' minor' : k + ' major'} · ${camelot(k)}`} onClick={() => toggle(k)}>
                  {k}
                </button>
              ))}
            </div>
          ))}
          <div className="popover-actions">
            <button
              className="link-btn"
              disabled={keys.length !== 1}
              title="Add the relative key and the keys a fifth up and down"
              onClick={() => onChange(compatibleKeys(keys[0]))}
            >
              + Compatible keys
            </button>
            <button className="link-btn" disabled={!keys.length} onClick={() => onChange([])}>
              Clear
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
