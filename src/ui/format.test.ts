import { describe, expect, it } from 'vitest'
import { chanceFoundByNow, formatDuration, formatNumber, secondsForChance } from './format'

describe('formatNumber', () => {
  it('uses compact suffixes and switches to exponent form for astronomic values', () => {
    expect(formatNumber(950)).toBe('950')
    expect(formatNumber(16_777_216)).toBe('16.8M')
    expect(formatNumber(890_212_619)).toBe('890.2M')
    expect(formatNumber(4.3e12)).toBe('4.3T')
    expect(formatNumber(16 ** 40)).toBe('1.5e48')
  })
})

describe('formatDuration', () => {
  it('never shows a misleading 0s', () => {
    expect(formatDuration(0.02)).toBe('<1s')
    expect(formatDuration(42)).toBe('42s')
    expect(formatDuration(5400)).toBe('1.5h')
  })
})

describe('odds', () => {
  it('50% of searches finish within D*ln2 keys', () => {
    expect(secondsForChance(1000, 10, 0.5)).toBeCloseTo((1000 * Math.LN2) / 10)
    expect(chanceFoundByNow(1000, 1000 * Math.LN2)).toBeCloseTo(0.5)
  })

  it('handles a stopped engine and a trivial pattern', () => {
    expect(secondsForChance(1000, 0, 0.5)).toBe(Infinity)
    expect(chanceFoundByNow(0, 0)).toBe(1)
  })
})
