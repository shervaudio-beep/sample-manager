// Preload for the hidden analyzer page: receives files to analyze, sends results back.

import { contextBridge, ipcRenderer } from 'electron'
import type { AnalyzerJob, AnalyzerReply } from '../shared/types'

const analyzer = {
  onJob: (cb: (job: AnalyzerJob) => void): void => {
    ipcRenderer.on('analyzer:job', (_e, job: AnalyzerJob) => cb(job))
  },
  reply: (r: AnalyzerReply): void => ipcRenderer.send('analyzer:result', r)
}

export type AnalyzerApi = typeof analyzer
contextBridge.exposeInMainWorld('analyzer', analyzer)
