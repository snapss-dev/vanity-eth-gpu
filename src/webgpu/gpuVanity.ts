import { buildShader, resultsBufferBytes, RESULT_WORDS, RESULTS_HEADER_WORDS, type KernelConfig } from './shader'
import {
  addressWordsToHex, bigIntToHex32, buildCombTable, buildSearchTable, CURVE_ORDER, randomScalars, walkerPrivateKey,
} from './precompute'
import { deriveWalletAddressFromPriv } from '../vanityResult'
import { firstContractAddressFromWalletHex } from '../wallet/ethAddress'
import { hexToBytes } from '../utils/hex'
import type { PrivKey32 } from '../wallet/keys'

export type GpuSearchJob = {
  /** Address-word mask/value from patternToMask(). */
  mask: Uint32Array
  value: Uint32Array
  /** 0 = wallet address, 1 = first CREATE contract address. */
  mode: number
}

/** A point whose (lowercase) address matched the mask. Callers must still verify it. */
export type GpuHit = { privHex: string; addressHex: string }

export type GpuStep = { checked: number; hits: GpuHit[] }

export type GpuVanity = {
  label: string
  /** Begin a search with fresh random walkers. The engine must be idle (see drain). */
  start(job: GpuSearchJob): void
  /** Keep the GPU queue full and resolve with the next finished dispatch. */
  step(): Promise<GpuStep>
  /** Wait for in-flight work to finish so the engine is idle again. */
  drain(): Promise<void>
  /** Known-answer test on this device. Resolves to null on success, else a reason. */
  selfTest(): Promise<string | null>
  destroy(): void
}

export type GpuVanityPool = {
  // One independent instance per physical GPU.
  instances: GpuVanity[]
  // Human-readable label per instance, same order as `instances`.
  labels: string[]
  destroy(): void
}

export const DEFAULT_KERNEL_CONFIG: KernelConfig = { workgroupSize: 64, tableSize: 63, maxResults: 1024, mulRows: 1 }
const MAX_WALKERS = 65536
const MAX_IN_FLIGHT = 2
const SLOTS = MAX_IN_FLIGHT + 1
// Keep each dispatch short: the GPU is shared with the compositor (long
// dispatches make the page stutter) and the OS kills devices whose work runs
// for ~2 s. The window of walkers per dispatch adapts toward this target.
const TARGET_DISPATCH_MS = 30
const INITIAL_WINDOW = 512

// Build a short, human-readable label from a GPUAdapter's info.
function adapterLabel(adapter: GPUAdapter, index: number): string {
  const info = (adapter as { info?: GPUAdapterInfo }).info
  if (info) {
    const name = info.description || [info.vendor, info.architecture].filter(Boolean).join(' ')
    if (name) return name
  }
  return `GPU ${index + 1}`
}

// Stable identity key so we don't run two devices on the same physical GPU.
function adapterKey(adapter: GPUAdapter, index: number): string {
  const info = (adapter as { info?: GPUAdapterInfo }).info
  if (info) {
    const key = [info.vendor, info.architecture, info.device, info.description]
      .filter(Boolean)
      .join('|')
    if (key) return key
  }
  return `adapter-${index}`
}

function isFallbackAdapter(adapter: GPUAdapter): boolean {
  const a = adapter as { info?: { isFallbackAdapter?: boolean }; isFallbackAdapter?: boolean }
  return Boolean(a.info?.isFallbackAdapter ?? a.isFallbackAdapter)
}

// Discover the distinct physical GPUs the browser is willing to expose.
// WebGPU has no "enumerate all adapters" API — the only lever is
// powerPreference, which on multi-GPU machines surfaces different chips
// (except on Windows, where Chrome currently ignores it).
export async function enumerateGpuAdapters(allowFallback = false): Promise<GPUAdapter[]> {
  if (!navigator.gpu) throw new Error('WebGPU not supported')

  const prefs: GPUPowerPreference[] = ['high-performance', 'low-power']
  const adapters: GPUAdapter[] = []
  const seen = new Set<string>()

  for (const powerPreference of prefs) {
    let adapter: GPUAdapter | null = null
    try {
      adapter = await navigator.gpu.requestAdapter({ powerPreference })
    } catch {
      adapter = null
    }
    if (!adapter) continue
    // A software rasterizer would be slower than the CPU workers.
    if (!allowFallback && isFallbackAdapter(adapter)) continue
    const key = adapterKey(adapter, adapters.length)
    if (seen.has(key)) continue
    seen.add(key)
    adapters.push(adapter)
  }

  return adapters
}

type Slot = {
  searchParams: GPUBuffer
  initParams: GPUBuffer
  results: GPUBuffer
  readback: GPUBuffer
  searchBind: GPUBindGroup
  initBind: GPUBindGroup
}

type Dispatch = {
  slot: Slot
  walkers: number
  done: Promise<void>
  submittedAt: number
  scalars: Uint32Array
}

type Job = GpuSearchJob & { scalars: Uint32Array }

export async function createGpuVanity(
  adapter: GPUAdapter,
  label = adapterLabel(adapter, 0),
  overrides: Partial<KernelConfig> = {},
): Promise<GpuVanity> {
  const CONFIG: KernelConfig = { ...DEFAULT_KERNEL_CONFIG, ...overrides }
  const POINTS_PER_WALKER = 2 * CONFIG.tableSize + 1
  const device = await adapter.requestDevice()

  let destroyed = false
  // An in-flight mapAsync rejects when the device is lost; callers turn that
  // into a fallback. Log the reason for diagnostics.
  void device.lost.then((info) => {
    if (!destroyed) console.warn(`[vanity] WebGPU device "${label}" lost: ${info.reason ?? 'unknown'} — ${info.message}`)
  })

  const module = device.createShaderModule({ code: buildShader(CONFIG) })
  const compileErrors = (await module.getCompilationInfo()).messages.filter(m => m.type === 'error')
  if (compileErrors.length) {
    device.destroy()
    throw new Error('WGSL compile failed: ' + compileErrors.map(e => `${e.lineNum}:${e.linePos} ${e.message}`).join('; '))
  }
  // Async pipeline creation keeps the (large) shader compile off the main thread.
  const [searchPipeline, initPipeline] = await Promise.all([
    device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'search' } }),
    device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'init' } }),
  ])

  const STORAGE = GPUBufferUsage.STORAGE
  const walkersBuf = device.createBuffer({ size: MAX_WALKERS * 16 * 4, usage: STORAGE })
  const countersBuf = device.createBuffer({ size: MAX_WALKERS * 4, usage: STORAGE })
  const scalarsBuf = device.createBuffer({ size: MAX_WALKERS * 8 * 4, usage: STORAGE | GPUBufferUsage.COPY_DST })
  const table = buildSearchTable(CONFIG.tableSize)
  const tableBuf = device.createBuffer({ size: table.byteLength, usage: STORAGE | GPUBufferUsage.COPY_DST })
  device.queue.writeBuffer(tableBuf, 0, table)
  const comb = buildCombTable()
  const combBuf = device.createBuffer({ size: comb.byteLength, usage: STORAGE | GPUBufferUsage.COPY_DST })
  device.queue.writeBuffer(combBuf, 0, comb)

  const resultsBytes = resultsBufferBytes(CONFIG)
  const slots: Slot[] = Array.from({ length: SLOTS }, () => {
    const searchParams = device.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    const initParams = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    const results = device.createBuffer({ size: resultsBytes, usage: STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST })
    const readback = device.createBuffer({ size: resultsBytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })
    const searchBind = device.createBindGroup({
      layout: searchPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: searchParams } },
        { binding: 1, resource: { buffer: walkersBuf } },
        { binding: 2, resource: { buffer: countersBuf } },
        { binding: 3, resource: { buffer: tableBuf } },
        { binding: 4, resource: { buffer: results } },
      ],
    })
    const initBind = device.createBindGroup({
      layout: initPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 1, resource: { buffer: walkersBuf } },
        { binding: 2, resource: { buffer: countersBuf } },
        { binding: 5, resource: { buffer: initParams } },
        { binding: 6, resource: { buffer: scalarsBuf } },
        { binding: 7, resource: { buffer: combBuf } },
      ],
    })
    return { searchParams, initParams, results, readback, searchBind, initBind }
  })

  let job: Job | null = null
  let initialized = 0 // walkers [0, initialized) hold the current job's start points
  let cursor = 0
  let window = INITIAL_WINDOW
  let nextSlot = 0
  let lastDoneAt = 0
  const inflight: Dispatch[] = []
  const searchParamData = new Uint32Array(20)
  const initParamData = new Uint32Array(4)
  const WG = CONFIG.workgroupSize

  function submit(base: number, count: number): void {
    const j = job!
    const slot = slots[nextSlot]
    nextSlot = (nextSlot + 1) % SLOTS
    const encoder = device.createCommandEncoder()
    encoder.clearBuffer(slot.results, 0, RESULTS_HEADER_WORDS * 4)

    // Walkers are seeded lazily on their first visit, so a small GPU that only
    // ever needs a few thousand of them never pays to initialize the rest.
    if (initialized < base + count) {
      const from = Math.max(initialized, base)
      initParamData[0] = from
      initParamData[1] = base + count - from
      initParamData[2] = 8 / CONFIG.mulRows
      device.queue.writeBuffer(slot.initParams, 0, initParamData)
      const pass = encoder.beginComputePass()
      pass.setPipeline(initPipeline)
      pass.setBindGroup(0, slot.initBind)
      pass.dispatchWorkgroups(Math.ceil((base + count - from) / WG))
      pass.end()
      initialized = base + count
    }

    searchParamData.fill(0)
    searchParamData[0] = base
    searchParamData[1] = count
    searchParamData[2] = j.mode
    searchParamData[3] = 8 / CONFIG.mulRows
    searchParamData.set(j.mask, 4)
    searchParamData.set(j.value, 12)
    device.queue.writeBuffer(slot.searchParams, 0, searchParamData)
    const pass = encoder.beginComputePass()
    pass.setPipeline(searchPipeline)
    pass.setBindGroup(0, slot.searchBind)
    pass.dispatchWorkgroups(Math.ceil(count / WG))
    pass.end()

    encoder.copyBufferToBuffer(slot.results, 0, slot.readback, 0, resultsBytes)
    device.queue.submit([encoder.finish()])
    const done = slot.readback.mapAsync(GPUMapMode.READ)
    done.catch(() => {}) // observed by step()/drain(); avoid unhandled-rejection noise
    inflight.push({ slot, walkers: count, done, submittedAt: performance.now(), scalars: j.scalars })
  }

  function submitNext(): void {
    const count = Math.min(window, MAX_WALKERS - cursor)
    submit(cursor, count)
    cursor = cursor + count >= MAX_WALKERS ? 0 : cursor + count
  }

  // Read a finished dispatch's results and release its readback buffer.
  async function collect(d: Dispatch): Promise<{ hits: GpuHit[]; raw: number }> {
    await d.done
    const words = new Uint32Array(d.slot.readback.getMappedRange()).slice()
    d.slot.readback.unmap()
    const raw = words[0]
    const n = Math.min(raw, CONFIG.maxResults)
    const hits: GpuHit[] = []
    for (let k = 0; k < n; k++) {
      const o = RESULTS_HEADER_WORDS + k * RESULT_WORDS
      const walker = words[o]
      const offset = words[o + 1] | 0
      const counter = words[o + 2]
      const addressHex = addressWordsToHex(words.subarray(o + 3, o + 8))
      // A corrupted entry yields an empty key, which verification rejects.
      const valid = walker < MAX_WALKERS && Math.abs(offset) <= CONFIG.tableSize
      const privHex = valid ? bigIntToHex32(walkerPrivateKey(d.scalars, walker, counter, offset, CONFIG.tableSize)) : ''
      hits.push({ privHex, addressHex })
    }
    return { hits, raw }
  }

  function adapt(d: Dispatch, finishedAt: number): void {
    const gpuMs = finishedAt - Math.max(lastDoneAt, d.submittedAt)
    lastDoneAt = finishedAt
    if (gpuMs <= 0) return
    // Clamp relative to the current window, not this dispatch: the last
    // dispatch of each sweep is truncated and must not drag the window down.
    const ideal = (d.walkers * TARGET_DISPATCH_MS) / gpuMs
    const next = Math.round(Math.min(window * 2, Math.max(window / 2, ideal)) / WG) * WG
    window = Math.min(MAX_WALKERS, Math.max(WG, next))
  }

  async function step(): Promise<GpuStep> {
    if (destroyed) throw new Error('GPU vanity destroyed')
    if (!job) throw new Error('GPU search not started')
    while (inflight.length < MAX_IN_FLIGHT) submitNext()
    const d = inflight.shift()!
    const { hits } = await collect(d)
    adapt(d, performance.now())
    return { checked: d.walkers * POINTS_PER_WALKER, hits }
  }

  async function drain(): Promise<void> {
    const pending = inflight.splice(0)
    await Promise.allSettled(pending.map(d => d.done))
    for (const d of pending) if (d.slot.readback.mapState === 'mapped') d.slot.readback.unmap()
  }

  function start(next: GpuSearchJob): void {
    if (destroyed) throw new Error('GPU vanity destroyed')
    if (inflight.length) throw new Error('GPU search still running; drain() first')
    // Fresh walkers for every search keeps keys from separate searches unrelated.
    const scalars = randomScalars(MAX_WALKERS)
    device.queue.writeBuffer(scalarsBuf, 0, scalars)
    job = { ...next, mask: next.mask.slice(), value: next.value.slice(), scalars }
    initialized = 0
    cursor = 0
    lastDoneAt = 0
  }

  // Known-answer test: four walkers whose keys include the extremes 1 and n-1,
  // a match-everything pattern, and every reported point re-derived with
  // @noble. Covers init, the batched inversion, both table directions, the
  // advance step and both address modes on the user's actual GPU/driver.
  async function selfTest(): Promise<string | null> {
    if (inflight.length) throw new Error('GPU search still running; drain() first')
    const m = CONFIG.tableSize
    const scalars = randomScalars(4)
    const setScalar = (i: number, v: bigint) => {
      for (let l = 0; l < 8; l++) scalars[i * 8 + l] = Number((v >> BigInt(32 * l)) & 0xffffffffn)
    }
    setScalar(0, BigInt(m + 1))                                     // keys 1 ..
    setScalar(3, CURVE_ORDER - 1n - BigInt(m) - BigInt(POINTS_PER_WALKER)) // .. n-1 on the 2nd pass
    device.queue.writeBuffer(scalarsBuf, 0, scalars)
    const zero = new Uint32Array(5)
    initialized = 0

    try {
      for (const mode of [0, 1]) {
        job = { mask: zero, value: zero, mode, scalars }
        submit(0, 4)
        const d = inflight.shift()!
        const { hits, raw } = await collect(d)
        const expected = 4 * POINTS_PER_WALKER
        if (raw !== expected) return `mode ${mode}: expected ${expected} results, got ${raw}`
        const seen = new Set<string>()
        for (const h of hits) {
          if (!h.privHex) return `mode ${mode}: corrupted result entry`
          if (seen.has(h.privHex)) return `mode ${mode}: duplicate key`
          seen.add(h.privHex)
          const wallet = deriveWalletAddressFromPriv(hexToBytes(h.privHex) as PrivKey32).slice(2).toLowerCase()
          const want = mode === 1 ? firstContractAddressFromWalletHex(wallet) : wallet
          if (want !== h.addressHex) return `mode ${mode}: key ${h.privHex} -> ${want}, GPU said ${h.addressHex}`
        }
      }
      return null
    } catch (err) {
      return err instanceof Error ? err.message : String(err)
    } finally {
      await drain()
      job = null
      initialized = 0
    }
  }

  function destroy() {
    if (destroyed) return
    destroyed = true
    job = null
    device.destroy() // also releases every buffer
  }

  return { label, start, step, drain, selfTest, destroy }
}

// Create one independent GpuVanity instance per distinct physical GPU.
// Falls back to a single instance when only one GPU is available.
export async function createGpuVanityPool(
  opts: { allowFallbackAdapter?: boolean; kernel?: Partial<KernelConfig> } = {},
): Promise<GpuVanityPool> {
  const adapters = await enumerateGpuAdapters(opts.allowFallbackAdapter)
  if (adapters.length === 0) throw new Error('No WebGPU adapter')

  const instances: GpuVanity[] = []
  const labels: string[] = []
  const errors: string[] = []

  for (let i = 0; i < adapters.length; i++) {
    try {
      const inst = await createGpuVanity(adapters[i], adapterLabel(adapters[i], i), opts.kernel)
      instances.push(inst)
      labels.push(inst.label)
    } catch (err) {
      // Skip a GPU whose device creation failed; others may still work.
      errors.push(err instanceof Error ? err.message : String(err))
    }
  }

  if (instances.length === 0) throw new Error('Failed to create any GPU device: ' + errors.join('; '))

  return {
    instances,
    labels,
    destroy() {
      for (const inst of instances) inst.destroy()
    },
  }
}
