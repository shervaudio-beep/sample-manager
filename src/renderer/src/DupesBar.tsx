// Summary and actions shown above the list in the Duplicates view.

import type { DuplicateStats } from '../../shared/types'
import type { DupeState } from './App'
import { formatSize } from './format'

const STAGE_LABEL: Record<NonNullable<DupeState['stage']>, string> = {
  locating: 'Reading new files',
  comparing: 'Comparing',
  verifying: 'Verifying matches'
}

const isMac = navigator.platform.toLowerCase().includes('mac')

interface Props {
  stats: DuplicateStats | null
  state: DupeState
  selected: number
  onSelectExtra: () => void
  onTrash: () => void
  onCheck: () => void
}

export function DupesBar({ stats, state, selected, onSelectExtra, onTrash, onCheck }: Props): React.JSX.Element {
  return (
    <div className="dupebar">
      <div className="dupebar-text">
        {state.running ? (
          <>
            <span className="spinner" /> {state.stage ? STAGE_LABEL[state.stage] : 'Checking'}…{' '}
            {state.total > 0 && `${state.done.toLocaleString()} / ${state.total.toLocaleString()}`}
          </>
        ) : stats && stats.groups > 0 ? (
          <>
            <b>{stats.groups.toLocaleString()}</b> {stats.groups === 1 ? 'sound is' : 'sounds are'} in your library more than
            once. The extra {stats.extra === 1 ? 'copy uses' : `${stats.extra.toLocaleString()} copies use`} <b>{formatSize(stats.extraBytes)}</b>.
          </>
        ) : (
          'Files with exactly the same audio show up here, even with different names, folders or tags.'
        )}
      </div>
      {stats && stats.groups > 0 && (
        <>
          <button className="btn small" onClick={onSelectExtra} title="Select every copy except the one to keep in each set (the one you've rated, tagged or collected; otherwise the oldest)">
            Select extra copies
          </button>
          <button className="btn small danger" disabled={selected === 0} onClick={onTrash}>
            Move {selected > 0 ? selected.toLocaleString() + ' ' : ''}to {isMac ? 'Trash' : 'Recycle Bin'}…
          </button>
        </>
      )}
      <button className="btn small" disabled={state.running} onClick={onCheck} title="Check new or changed files">
        Check again
      </button>
    </div>
  )
}
