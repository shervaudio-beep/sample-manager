// Hidden page that listens to files: Chromium decodes any format it can play (resampled to a
// low rate, mixed to mono), then the shared analysis finds tempo and key. Runs in its own
// process, so the main window never waits on it.

import { analyzeSignal, ANALYSIS_SAMPLE_RATE } from '../../shared/analysis'

/** Enough to judge tempo and key; keeps memory flat for long beats. */
const MAX_SECONDS = 120

window.analyzer.onJob(async (job) => {
  try {
    const res = await fetch(job.url)
    if (!res.ok) throw new Error(`Couldn't read the file (${res.status})`)
    const data = await res.arrayBuffer()
    const ctx = new OfflineAudioContext(1, 1, ANALYSIS_SAMPLE_RATE)
    const audio = await ctx.decodeAudioData(data)
    const length = Math.min(audio.length, ANALYSIS_SAMPLE_RATE * MAX_SECONDS)
    const mono = new Float32Array(length)
    for (let ch = 0; ch < audio.numberOfChannels; ch++) {
      const d = audio.getChannelData(ch)
      for (let i = 0; i < length; i++) mono[i] += d[i] / audio.numberOfChannels
    }
    const result = analyzeSignal(mono, ANALYSIS_SAMPLE_RATE, { ...job.request, durationSec: audio.duration })
    window.analyzer.reply({ id: job.id, result })
  } catch (err) {
    window.analyzer.reply({ id: job.id, error: err instanceof Error ? err.message : String(err) })
  }
})
