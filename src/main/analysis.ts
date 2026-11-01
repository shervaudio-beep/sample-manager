// Feeds files to the hidden analyzer page and stores what it hears. Runs after duplicate
// checking, newest files first, two at a time; remembers what's done, so it picks up where it
// left off after a restart. Never writes to audio files.

import { BrowserWindow, ipcMain } from 'electron'
import path from 'node:path'
import { ANALYSIS_VERSION, APPLY_BPM_CONFIDENCE, APPLY_KEY_CONFIDENCE, planAnalysis, type AnalysisRequest } from '../shared/analysis'
import type { AnalysisEvent, AnalyzerReply } from '../shared/types'
import { analysisQueue, markAnalyzed, saveAnalysis, type Db } from './db'

const CONCURRENCY = 2
const JOB_TIMEOUT_MS = 60_000

export class AudioAnalyzer {
  private win: BrowserWindow | null = null
  private running = false
  private again = false
  private pending = new Map<number, (r: AnalyzerReply) => void>()

  constructor(
    private db: () => Db,
    private send: (e: AnalysisEvent) => void,
    private audioUrl: (id: number) => string
  ) {
    ipcMain.on('analyzer:result', (_e, r: AnalyzerReply) => {
      this.pending.get(r.id)?.(r)
    })
  }

  get busy(): boolean {
    return this.running
  }

  /** Analyze whatever is new. Safe to call any time; overlapping calls queue one more pass. */
  async run(): Promise<void> {
    if (this.running) {
      this.again = true
      return
    }
    this.running = true
    try {
      const db = this.db()
      const queue = analysisQueue(db, ANALYSIS_VERSION)
      const skip: number[] = []
      const jobs: Array<{ id: number; request: AnalysisRequest }> = []
      for (const f of queue) {
        const request = planAnalysis(f)
        if (request) jobs.push({ id: f.id, request })
        else skip.push(f.id)
      }
      markAnalyzed(db, skip, ANALYSIS_VERSION)
      if (!jobs.length) return

      let done = 0
      this.send({ type: 'progress', done, total: jobs.length })
      let next = 0
      const worker = async (): Promise<void> => {
        while (next < jobs.length) {
          const job = jobs[next++]
          const reply = await this.analyze(job.id, job.request)
          if (reply.result) saveAnalysis(db, job.id, ANALYSIS_VERSION, reply.result, { bpm: APPLY_BPM_CONFIDENCE, key: APPLY_KEY_CONFIDENCE })
          // Undecodable or vanished: mark it done so it isn't retried every time.
          else markAnalyzed(db, [job.id], ANALYSIS_VERSION)
          done++
          if (done % 5 === 0 || done === jobs.length) this.send({ type: 'progress', done, total: jobs.length })
        }
      }
      await Promise.all(Array.from({ length: CONCURRENCY }, worker))
    } finally {
      this.running = false
      // Free the decoder's memory between passes.
      this.win?.destroy()
      this.win = null
      this.send({ type: 'done' })
      if (this.again) {
        this.again = false
        void this.run()
      }
    }
  }

  stop(): void {
    this.win?.destroy()
    this.win = null
  }

  private async window(): Promise<BrowserWindow> {
    if (this.win && !this.win.isDestroyed()) return this.win
    const w = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: path.join(import.meta.dirname, '../preload/analyzer.mjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false
      }
    })
    // If the page crashes (e.g. a decoder blew up on a broken file), fail what's in flight.
    w.webContents.on('render-process-gone', () => {
      for (const [id, resolve] of this.pending) resolve({ id, error: 'Analyzer stopped' })
      this.pending.clear()
      this.win = null
    })
    const loaded = new Promise<void>((resolve) => w.webContents.once('did-finish-load', () => resolve()))
    if (process.env.ELECTRON_RENDERER_URL) await w.loadURL(process.env.ELECTRON_RENDERER_URL + '/analyzer.html')
    else await w.loadFile(path.join(import.meta.dirname, '../renderer/analyzer.html'))
    await loaded
    this.win = w
    return w
  }

  private async analyze(id: number, request: AnalysisRequest): Promise<AnalyzerReply> {
    let w: BrowserWindow
    try {
      w = await this.window()
    } catch (err) {
      return { id, error: String(err) }
    }
    return new Promise<AnalyzerReply>((resolve) => {
      const timer = setTimeout(() => finish({ id, error: 'Timed out' }), JOB_TIMEOUT_MS)
      const finish = (r: AnalyzerReply): void => {
        clearTimeout(timer)
        this.pending.delete(id)
        resolve(r)
      }
      this.pending.set(id, finish)
      w.webContents.send('analyzer:job', { id, url: this.audioUrl(id), request })
    })
  }
}
