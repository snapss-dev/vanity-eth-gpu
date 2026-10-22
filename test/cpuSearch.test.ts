import { describe, it, expect } from 'vitest'
import { searchBatch, type CpuSearchJob } from '../src/worker/cpuSearch'
import { patternToMask } from '../src/webgpu/precompute'
import { mergeAddressPattern } from '../src/searchPattern'
import { verifyFoundResult } from '../src/vanityResult'
import type { SearchTarget } from '../src/searchTarget'

function job(prefix: string, suffix: string, target: SearchTarget, caseSensitive = false): CpuSearchJob {
  const { mask, value } = patternToMask(mergeAddressPattern(prefix.toLowerCase(), suffix.toLowerCase(), false).body)
  return { mask, value, mode: target === 'first-contract' ? 1 : 0, prefix, suffix, caseSensitive }
}

describe('CPU batched search (same algorithm as the GPU kernel)', () => {
  for (const target of ['wallet', 'first-contract'] as const) {
    it(`finds keys that really derive to a matching ${target} address`, () => {
      // Small table so every code path (centre, +/- sides, advance) runs many times.
      for (let n = 0; n < 12; n++) {
        const j = job('a', 'b', target)
        const r = searchBatch(j, 1e6, 7)
        expect(r.found).not.toBeNull()
        expect(verifyFoundResult(r.found!.privHex, r.found!.address, 'a', 'b', target, false)).not.toBeNull()
      }
    })
  }

  it('reports progress without a match and covers the advertised number of keys', () => {
    const r = searchBatch(job('0000000000', '', 'wallet'), 3000, 31)
    expect(r.found).toBeNull()
    expect(r.checked).toBeGreaterThanOrEqual(3000)
    expect(r.checked % 63).toBe(0)
  })

  it('applies the EIP-55 case rule when case-sensitive', () => {
    for (let n = 0; n < 6; n++) {
      const r = searchBatch(job('aB', 'C', 'wallet', true), 1e7, 15)
      expect(r.found).not.toBeNull()
      expect(r.found!.address.slice(2, 4)).toBe('aB')
      expect(r.found!.address.slice(-1)).toBe('C')
      expect(verifyFoundResult(r.found!.privHex, r.found!.address, 'aB', 'C', 'wallet', true)).not.toBeNull()
    }
  })
})
