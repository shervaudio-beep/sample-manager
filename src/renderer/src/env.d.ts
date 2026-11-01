/// <reference types="vite/client" />
import type { AnalyzerApi } from '../../preload/analyzer'
import type { Api } from '../../preload/index'

declare global {
  interface Window {
    api: Api
    /** Only on the hidden analyzer page. */
    analyzer: AnalyzerApi
  }
}
