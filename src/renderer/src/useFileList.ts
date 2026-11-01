// Windowed access to the file list: the table only asks for the rows it is about to draw,
// fetched from SQLite in pages, so 50k+ files cost no more than a few hundred.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { FileQuery, FileRow } from '../../shared/types'

const PAGE = 200

export type ListFilter = Omit<FileQuery, 'offset' | 'limit'>

export interface FileList {
  total: number
  rowAt: (index: number) => FileRow | undefined
  ensureRange: (start: number, end: number) => void
}

export function useFileList(filter: ListFilter, version: number): FileList {
  const [total, setTotal] = useState(0)
  const [, setTick] = useState(0)
  const pages = useRef(new Map<number, FileRow[]>())
  const loading = useRef(new Set<number>())
  const generation = useRef(0)
  const visible = useRef<[number, number]>([0, 50])
  const filterKey = JSON.stringify(filter)

  const fetchPage = useCallback(
    async (page: number, gen: number, into: Map<number, FileRow[]>) => {
      const rows = await window.api.queryFiles({ ...filter, offset: page * PAGE, limit: PAGE })
      if (gen === generation.current) into.set(page, rows)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filterKey]
  )

  // Filter/sort changed or the library changed underneath us (scan): reload the visible pages
  // into a fresh map and swap it in, so rows don't blank out mid-scan.
  useEffect(() => {
    const gen = ++generation.current
    const fresh = new Map<number, FileRow[]>()
    const [start, end] = visible.current
    const wanted: number[] = []
    for (let p = Math.floor(start / PAGE); p <= Math.floor(end / PAGE); p++) wanted.push(p)
    Promise.all([window.api.countFiles(filter), ...wanted.map((p) => fetchPage(p, gen, fresh))]).then(([n]) => {
      if (gen !== generation.current) return
      pages.current = fresh
      loading.current.clear()
      setTotal(n as number)
      setTick((t) => t + 1)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey, version, fetchPage])

  const ensureRange = useCallback(
    (start: number, end: number) => {
      visible.current = [start, end]
      const gen = generation.current
      for (let p = Math.floor(start / PAGE); p <= Math.floor(end / PAGE); p++) {
        if (pages.current.has(p) || loading.current.has(p)) continue
        loading.current.add(p)
        const target = pages.current
        fetchPage(p, gen, target).then(() => {
          loading.current.delete(p)
          if (gen === generation.current) setTick((t) => t + 1)
        })
      }
    },
    [fetchPage]
  )

  const rowAt = useCallback((index: number) => pages.current.get(Math.floor(index / PAGE))?.[index % PAGE], [])

  return { total, rowAt, ensureRange }
}
