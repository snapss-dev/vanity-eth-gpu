// Runs inside a real browser (see scripts/gpu-test.mjs): exercises the WGSL
// kernel on actual hardware, which the Node suite can't do.
import { createGpuVanityPool } from '../../src/webgpu/gpuVanity'
import { patternToMask } from '../../src/webgpu/precompute'
import { mergeAddressPattern } from '../../src/searchPattern'
import { verifyFoundResult } from '../../src/vanityResult'
import type { SearchTarget } from '../../src/searchTarget'

export type GpuCheckReport = {
  adapters: string[]
  failures: string[]
  details: Record<string, unknown>
}

export async function runGpuCheck(opts: { allowFallbackAdapter?: boolean; seconds?: number } = {}): Promise<GpuCheckReport> {
  const failures: string[] = []
  const details: Record<string, unknown> = {}
  const t0 = performance.now()
  const pool = await createGpuVanityPool({ allowFallbackAdapter: opts.allowFallbackAdapter })
  details.setupMs = Math.round(performance.now() - t0)

  try {
    for (const gpu of pool.instances) {
      const tag = gpu.label
      const selfTest = await gpu.selfTest()
      if (selfTest) failures.push(`${tag}: self-test failed: ${selfTest}`)

      for (const [mode, target] of [[0, 'wallet'], [1, 'first-contract']] as Array<[number, SearchTarget]>) {
        // 1) every hit for an easy pattern must derive from its key
        const pre = 'a', suf = 'bc'
        let job = patternToMask(mergeAddressPattern(pre, suf, false).body)
        gpu.start({ ...job, mode })
        let ok = 0, bad = 0
        const until = performance.now() + 20000
        while (ok + bad < 200 && performance.now() < until) {
          for (const h of (await gpu.step()).hits) {
            verifyFoundResult(h.privHex, '0x' + h.addressHex, pre, suf, target, false) ? ok++ : bad++
          }
        }
        await gpu.drain()
        if (bad || ok < 50) failures.push(`${tag} ${target}: ${ok} verified, ${bad} wrong`)

        // 2) the hit rate must match the work the GPU claims to do
        const hPre = 'c0f', hSuf = 'fe'
        job = patternToMask(mergeAddressPattern(hPre, hSuf, false).body)
        gpu.start({ ...job, mode })
        let checked = 0, hits = 0
        const start = performance.now()
        const end = start + (opts.seconds ?? 4) * 1000
        while (performance.now() < end || hits < 30) {
          const r = await gpu.step()
          checked += r.checked
          hits += r.hits.length
          if (performance.now() > end + 30000) break
        }
        await gpu.drain()
        const expected = checked / 16 ** 5
        const ratio = hits / expected
        // ±4 standard deviations of a Poisson count
        if (Math.abs(hits - expected) > 4 * Math.sqrt(expected) + 2) failures.push(`${tag} ${target}: ${hits} hits, expected ~${expected.toFixed(0)}`)
        details[`${tag} ${target}`] = {
          verified: ok,
          keysPerSec: Math.round(checked / ((performance.now() - start) / 1000)),
          hitRatio: +ratio.toFixed(3),
        }
      }
    }
  } finally {
    pool.destroy()
  }
  return { adapters: pool.labels, failures, details }
}
