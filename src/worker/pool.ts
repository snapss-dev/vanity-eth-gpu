import VanityWorker from './vanityWorker?worker'
import type { CpuSearchJob, CpuSearchResult } from './cpuSearch'

/** One worker thread; each runs its own search loop, so no worker waits on another. */
export type CpuRunner = {
  search(job: CpuSearchJob, minPoints: number): Promise<CpuSearchResult>
}

export type WorkerPool = {
  runners: CpuRunner[]
  destroy(): void
}

/** Leave a core for the page and the rest of the system. */
export function defaultWorkerCount(): number {
  return Math.max(1, (navigator.hardwareConcurrency || 4) - 1)
}

export function createWorkerPool(count = defaultWorkerCount()): WorkerPool {
  const workers: Worker[] = []
  const rejectAll: Array<(err: Error) => void> = []
  let destroyed = false

  const runners = Array.from({ length: count }, (): CpuRunner => {
    const worker = new VanityWorker()
    workers.push(worker)
    const pending = new Map<number, { resolve: (r: CpuSearchResult) => void; reject: (e: Error) => void }>()
    let nextId = 0

    worker.onmessage = (e) => {
      const { id, error, ...result } = e.data
      const task = pending.get(id)
      if (!task) return
      pending.delete(id)
      if (error) task.reject(new Error(error))
      else task.resolve(result as CpuSearchResult)
    }
    const failAll = (err: Error) => {
      for (const task of pending.values()) task.reject(err)
      pending.clear()
    }
    rejectAll.push(failAll)
    // Errors inside a batch come back as messages; onerror means the worker
    // itself is broken (e.g. it failed to load), so retire it for good.
    let dead: Error | null = null
    worker.onerror = (e) => {
      e.preventDefault()
      dead = new Error(e.message || 'CPU worker crashed')
      worker.terminate()
      failAll(dead)
    }

    return {
      search(job, minPoints) {
        if (destroyed) return Promise.reject(new Error('Pool destroyed'))
        if (dead) return Promise.reject(dead)
        return new Promise((resolve, reject) => {
          const id = nextId++
          pending.set(id, { resolve, reject })
          worker.postMessage({ id, job, minPoints })
        })
      },
    }
  })

  return {
    runners,
    destroy() {
      destroyed = true
      for (const w of workers) w.terminate()
      workers.length = 0
      // Don't leave callers awaiting batches that will never come back.
      for (const fail of rejectAll) fail(new Error('Pool destroyed'))
    },
  }
}
