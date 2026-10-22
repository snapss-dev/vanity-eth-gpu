// Drives a search across the available engines.
//
// - The GPU engine is prepared once per page (shader build + an on-device
//   known-answer self-test) and reused for every later search.
// - If the GPU isn't ready yet, the search starts immediately on CPU workers and
//   moves to the GPU the moment it is, so nobody waits on a shader compile.
// - Every candidate is re-derived from its private key with @noble before it is
//   accepted. A GPU that ever reports a wrong key is retired for the session and
//   the search continues on the CPU.
import { createGpuVanityPool, type GpuVanity } from '../webgpu/gpuVanity'
import { patternToMask } from '../webgpu/precompute'
import { createWorkerPool, type CpuRunner, type WorkerPool } from '../worker/pool'
import type { CpuSearchJob } from '../worker/cpuSearch'
import { mergeAddressPattern } from '../searchPattern'
import { addressMatchesRequest, verifyFoundResult, type VerifiedVanityResult } from '../vanityResult'
import { checksumAddress } from '../wallet/ethAddress'
import type { SearchTarget } from '../searchTarget'

export type SearchRequest = {
  prefix: string
  suffix: string
  caseSensitive: boolean
  target: SearchTarget
}

export type Engine =
  | { kind: 'gpu'; labels: string[] }
  | { kind: 'cpu'; threads: number }

export type SearchEvents = {
  /** The engine now doing the work, plus an optional explanation (e.g. why it changed). */
  onEngine?(engine: Engine, note?: string): void
  /** Running total of keys checked. Called often; throttle any DOM work. */
  onProgress?(checked: number): void
}

export type SearchOutcome =
  | { status: 'found'; result: VerifiedVanityResult; checked: number; seconds: number }
  | { status: 'stopped'; checked: number }

type ReadyGpu = { instances: GpuVanity[]; labels: string[] }

type GpuState =
  | { kind: 'idle' }
  | { kind: 'preparing'; ready: Promise<ReadyGpu | null> }
  | { kind: 'ready'; gpu: ReadyGpu }
  | { kind: 'unavailable'; reason: string }

const CPU_BATCH_TARGET_MS = 250

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export type SearchController = ReturnType<typeof createSearchController>

export function createSearchController() {
  let gpuState: GpuState = { kind: 'idle' }
  let cpuPool: WorkerPool | null = null
  let active: { stop(): void } | null = null

  /** Start (or join) GPU preparation. Resolves to null when no GPU is usable. */
  function prepareGpu(): Promise<ReadyGpu | null> {
    switch (gpuState.kind) {
      case 'ready': return Promise.resolve(gpuState.gpu)
      case 'preparing': return gpuState.ready
      case 'unavailable': return Promise.resolve(null)
    }
    if (typeof navigator === 'undefined' || !navigator.gpu) {
      gpuState = { kind: 'unavailable', reason: 'WebGPU is not available in this browser' }
      return Promise.resolve(null)
    }
    const ready = (async (): Promise<ReadyGpu | null> => {
      try {
        const pool = await createGpuVanityPool()
        const gpu: ReadyGpu = { instances: [], labels: [] }
        for (const [i, inst] of pool.instances.entries()) {
          const failure = await inst.selfTest()
          if (failure) {
            console.warn(`[vanity] GPU "${inst.label}" failed its self-test, not using it: ${failure}`)
            inst.destroy()
          } else {
            gpu.instances.push(inst)
            gpu.labels.push(pool.labels[i])
          }
        }
        if (!gpu.instances.length) {
          gpuState = { kind: 'unavailable', reason: 'the GPU failed its self-test' }
          return null
        }
        gpuState = { kind: 'ready', gpu }
        return gpu
      } catch (err) {
        console.info('[vanity] GPU unavailable:', message(err))
        gpuState = { kind: 'unavailable', reason: message(err) }
        return null
      }
    })()
    gpuState = { kind: 'preparing', ready }
    return ready
  }

  function retireGpu(reason: string) {
    if (gpuState.kind === 'ready') for (const inst of gpuState.gpu.instances) inst.destroy()
    gpuState = { kind: 'unavailable', reason }
  }

  function workers(): CpuRunner[] {
    cpuPool ??= createWorkerPool()
    return cpuPool.runners
  }

  async function search(req: SearchRequest, events: SearchEvents = {}): Promise<SearchOutcome> {
    if (active) throw new Error('A search is already running')

    const pattern = mergeAddressPattern(req.prefix.toLowerCase(), req.suffix.toLowerCase(), false)
    if (!pattern.valid || pattern.constrainedNibbles === 0) throw new Error('Invalid pattern')
    const { mask, value } = patternToMask(pattern.body)
    const mode = req.target === 'first-contract' ? 1 : 0

    const startedAt = performance.now()
    let checked = 0
    let stopped = false
    let outcome: SearchOutcome | null = null
    let fatal: Error | null = null
    let finished!: () => void
    const done = new Promise<void>((resolve) => { finished = resolve })
    const stop = () => {
      if (stopped) return
      stopped = true
      finished()
    }
    active = { stop }
    try {
      const progress = (n: number) => {
        checked += n
        events.onProgress?.(checked)
      }

      /**
       * Returns false only for a key that does NOT derive to the reported
       * address, i.e. a broken engine. A lowercase match whose EIP-55 casing
       * doesn't fit a case-sensitive request is just a near miss.
       */
      const consider = (privHex: string, address: string): boolean => {
        if (req.caseSensitive && !addressMatchesRequest(checksumAddress(address), req.prefix, req.suffix, true)) return true
        const verified = verifyFoundResult(privHex, address, req.prefix, req.suffix, req.target, req.caseSensitive)
        if (!verified) return false
        if (!stopped) {
          outcome = { status: 'found', result: verified, checked, seconds: (performance.now() - startedAt) / 1000 }
          stop()
        }
        return true
      }

      // ── CPU ──
      let cpuWanted = false
      const cpuBusy = new Set<CpuRunner>()
      const cpuFailed = new Set<CpuRunner>()
      let gpuRunning = false
      // If every worker died (e.g. it couldn't load) and no GPU is running or on
      // its way, nothing is searching: fail loudly instead of spinning at 0/s.
      const checkStranded = () => {
        if (stopped || gpuRunning || gpuState.kind === 'preparing') return
        if (cpuFailed.size < workers().length) return
        fatal = new Error('No search engine could run: the CPU workers failed and no GPU is available')
        stop()
      }
      const cpuJob: CpuSearchJob = {
        mask: Array.from(mask), value: Array.from(value), mode,
        prefix: req.prefix, suffix: req.suffix, caseSensitive: req.caseSensitive,
      }
      const runCpu = (note?: string) => {
        cpuWanted = true
        const runners = workers()
        events.onEngine?.({ kind: 'cpu', threads: runners.length }, note)
        for (const runner of runners) {
          if (cpuBusy.has(runner) || cpuFailed.has(runner)) continue // busy runners will see cpuWanted
          cpuBusy.add(runner)
          void (async () => {
            let batch = 8192
            try {
              while (!stopped && cpuWanted) {
                const t0 = performance.now()
                const r = await runner.search(cpuJob, batch)
                if (stopped) break
                progress(r.checked)
                if (r.found && !consider(r.found.privHex, r.found.address)) {
                  console.error('[vanity] CPU worker returned a key that failed verification')
                }
                // Aim for batches of ~250 ms: responsive to Stop, cheap to dispatch.
                const ms = Math.max(1, performance.now() - t0)
                const scale = Math.min(4, Math.max(0.25, CPU_BATCH_TARGET_MS / ms))
                batch = Math.max(2048, Math.min(1 << 21, Math.round(batch * scale)))
              }
            } catch (err) {
              if (!stopped) {
                console.error('[vanity] CPU worker failed', err)
                cpuFailed.add(runner)
              }
            } finally {
              cpuBusy.delete(runner)
              if (cpuFailed.has(runner)) checkStranded()
            }
          })()
        }
      }

      // ── GPU ──
      let gpuLoops: Promise<void> | null = null
      const runGpu = (gpu: ReadyGpu) => {
        cpuWanted = false // CPU workers finish their current batch and stand down
        gpuRunning = true
        events.onEngine?.({ kind: 'gpu', labels: gpu.labels })
        gpuLoops = Promise.all(gpu.instances.map(async (inst) => {
          inst.start({ mask, value, mode })
          try {
            while (!stopped) {
              const r = await inst.step()
              if (stopped) break
              progress(r.checked)
              for (const hit of r.hits) {
                if (!consider(hit.privHex, hit.addressHex)) throw new Error(`GPU "${inst.label}" returned a key that failed verification`)
                if (stopped) break
              }
            }
          } finally {
            await inst.drain()
          }
        })).then(() => {}, (err) => {
          // Lost device, driver reset or a wrong result: never trust this GPU again.
          console.error('[vanity] GPU search failed', err)
          retireGpu(message(err))
          gpuRunning = false
          if (!stopped) {
            runCpu('The GPU stopped working, so the search moved to the CPU.')
            checkStranded()
          }
        })
      }

      if (gpuState.kind === 'ready') {
        runGpu(gpuState.gpu)
      } else {
        // Kick off (or join) GPU preparation first so the CPU status can say so.
        const gpuSoon = prepareGpu()
        runCpu()
        void gpuSoon.then((gpu) => {
          if (gpu && !stopped) runGpu(gpu)
          else checkStranded()
        })
      }

      await done
      // Leave the GPU idle so the next search can start right away. CPU
      // batches still in flight are simply ignored.
      if (gpuLoops) await gpuLoops
    } catch (err) {
      stop() // don't leave engines running for a search nobody is awaiting
      throw err
    } finally {
      active = null
    }
    if (fatal) throw fatal
    return outcome ?? { status: 'stopped', checked }
  }

  return {
    search,
    prepareGpu,
    stop() { active?.stop() },
    get running() { return active !== null },
    get gpuStatus(): GpuState['kind'] { return gpuState.kind },
    get gpuUnavailableReason(): string | null { return gpuState.kind === 'unavailable' ? gpuState.reason : null },
  }
}
