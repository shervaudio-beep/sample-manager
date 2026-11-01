// Tempo sync for previews: shared so it can be unit-tested without a browser.

/** Playback rate that lines a loop up with the project tempo, within a sane stretch range. */
export function syncRate(fileBpm: number | null, projectBpm: number): number {
  if (!fileBpm || !projectBpm) return 1
  let rate = projectBpm / fileBpm
  // Half/double time: 70 bpm loop in a 140 project plays at 1x, not 2x.
  while (rate > 1.5) rate /= 2
  while (rate < 0.75) rate *= 2
  return Math.round(rate * 1000) / 1000
}
