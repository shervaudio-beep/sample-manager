// Bottom transport: waveform, play/stop, volume and "sync to project BPM".
// One audio element for the whole app; App drives it through the PlayerHandle.

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import WaveSurfer from 'wavesurfer.js'
import { CATEGORY_SHORT, SUBTYPE_LABELS } from '../../shared/types'
import type { FileRow } from '../../shared/types'
import { formatBpm, stripExt } from './format'
import { loadSetting, saveSetting } from './settings'
import { syncRate } from '../../shared/sync'

export interface PlayerHandle {
  /** Load and play from the start. */
  play: (file: FileRow) => void
  /** Space bar: stop if playing, otherwise play `file` from the start. */
  toggle: (file: FileRow | null) => void
  stop: () => void
}

const PEAK_RESOLUTION = 1200

function formatClock(sec: number): string {
  if (!Number.isFinite(sec)) return '0:00'
  const s = Math.max(0, sec)
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`
}

export const PlayerBar = forwardRef<PlayerHandle>(function PlayerBar(_props, ref) {
  const waveRef = useRef<HTMLDivElement>(null)
  const ws = useRef<WaveSurfer | null>(null)
  const loadSeq = useRef(0)
  const [file, setFile] = useState<FileRow | null>(null)
  const [playing, setPlaying] = useState(false)
  const [loading, setLoading] = useState(false)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [volume, setVolume] = useState(() => loadSetting('volume', 0.8))
  const [sync, setSync] = useState(() => loadSetting('syncEnabled', false))
  const [projectBpm, setProjectBpm] = useState(() => loadSetting('projectBpm', 140))

  const rate = sync && file ? syncRate(file.bpm, projectBpm) : 1

  useEffect(() => {
    const media = new Audio()
    media.preservesPitch = true
    const w = WaveSurfer.create({
      container: waveRef.current!,
      media,
      height: 44,
      waveColor: '#3b414d',
      progressColor: '#ff8a3d',
      cursorColor: '#ffffff',
      cursorWidth: 1,
      barWidth: 2,
      barGap: 1,
      barRadius: 1,
      normalize: true,
      dragToSeek: true
    })
    w.on('play', () => setPlaying(true))
    w.on('pause', () => setPlaying(false))
    w.on('finish', () => setPlaying(false))
    w.on('timeupdate', (t) => setTime(t))
    w.on('error', (e) => {
      setLoading(false)
      setError(e?.message?.includes('404') ? 'File not found' : 'Can’t play this file')
    })
    ws.current = w
    return () => w.destroy()
  }, [])

  useEffect(() => {
    ws.current?.setVolume(volume)
    saveSetting('volume', volume)
  }, [volume])

  useEffect(() => {
    ws.current?.setPlaybackRate(rate, true)
  }, [rate])

  useEffect(() => saveSetting('syncEnabled', sync), [sync])
  useEffect(() => saveSetting('projectBpm', projectBpm), [projectBpm])

  const play = async (f: FileRow): Promise<void> => {
    const w = ws.current
    if (!w) return
    const seq = ++loadSeq.current
    setFile(f)
    setError(null)
    setTime(0)
    if (f.status !== 'ok') {
      w.empty()
      setError(f.status === 'offline' ? 'Drive is offline' : 'File not found')
      return
    }
    setLoading(true)
    try {
      const cached = await window.api.getWaveform(f.id)
      if (seq !== loadSeq.current) return
      await w.load(window.api.audioUrl(f.id), cached?.peaks, cached?.duration)
      if (seq !== loadSeq.current) return
      setDuration(w.getDuration())
      w.setPlaybackRate(sync ? syncRate(f.bpm, projectBpm) : 1, true)
      await w.play()
      if (!cached) {
        const peaks = w.exportPeaks({ maxLength: PEAK_RESOLUTION, precision: 10_000 })
        window.api.saveWaveform(f.id, { duration: w.getDuration(), peaks })
      }
    } catch (err) {
      // A newer load superseded this one: not an error.
      if (seq !== loadSeq.current || (err as Error)?.name === 'AbortError') return
      setError('Can’t play this file')
    } finally {
      if (seq === loadSeq.current) setLoading(false)
    }
  }

  const stop = (): void => {
    ws.current?.stop()
  }

  useImperativeHandle(ref, () => ({
    play,
    stop,
    toggle: (f) => {
      if (ws.current?.isPlaying()) stop()
      else if (f && f.id === file?.id && !error) ws.current?.play()
      else if (f) play(f)
    }
  }))

  return (
    <footer className="player">
      <button
        className={`play-btn${playing ? ' on' : ''}`}
        title="Play / stop (Space)"
        disabled={!file}
        onClick={() => (playing ? stop() : file && ws.current?.play())}
      >
        {playing ? '■' : '▶'}
      </button>

      <div className="now">
        {file ? (
          <>
            <div className="now-name" title={file.path}>
              {stripExt(file.name)}
            </div>
            <div className="now-meta">
              <span className={`cat-${file.category}`}>{CATEGORY_SHORT[file.category]}</span>
              {file.subtype && <span>{SUBTYPE_LABELS[file.subtype]}</span>}
              {file.bpm != null && <span>{formatBpm(file.bpm)} BPM</span>}
              {file.key && <span>{file.key}</span>}
            </div>
          </>
        ) : (
          <div className="now-empty">Click a file to preview · Space play/stop · ↑↓ browse</div>
        )}
      </div>

      <div className="wave-wrap">
        <div ref={waveRef} className={`wave${loading ? ' loading' : ''}`} />
        {error && <div className="wave-error">{error}</div>}
      </div>

      <div className="clock">
        {formatClock(time)} <span>/ {formatClock(duration)}</span>
      </div>

      <label className="volume" title="Volume">
        <span>VOL</span>
        <input type="range" min={0} max={1} step={0.01} value={volume} onChange={(e) => setVolume(Number(e.target.value))} />
      </label>

      <div className={`sync${sync ? ' on' : ''}`} title="Time-stretch loops that have a BPM to the project tempo (pitch is kept)">
        <button className="sync-toggle" onClick={() => setSync((s) => !s)}>
          SYNC
        </button>
        <input
          type="number"
          min={40}
          max={300}
          value={projectBpm}
          onChange={(e) => setProjectBpm(Math.min(300, Math.max(40, Number(e.target.value) || 0)))}
        />
        <span className="sync-rate">{sync && rate !== 1 ? `×${rate.toFixed(2)}` : 'BPM'}</span>
      </div>
    </footer>
  )
})
