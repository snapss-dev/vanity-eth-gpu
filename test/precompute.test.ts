import { describe, it, expect } from 'vitest'
import * as secp from '@noble/secp256k1'
import { keccak_256 } from '@noble/hashes/sha3.js'
import {
  addressWordsToHex, buildCombTable, buildSearchTable, CURVE_ORDER, limbsToBigInt, patternToMask, randomScalars,
  walkerPrivateKey,
} from '../src/webgpu/precompute'
import { mergeAddressPattern } from '../src/searchPattern'

const P = secp.Point.CURVE().p

function addressWords(addressHex: string): number[] {
  const bytes = Buffer.from(addressHex, 'hex')
  return [0, 1, 2, 3, 4].map(w => bytes.readUInt32LE(w * 4))
}

describe('patternToMask', () => {
  it('lays nibbles out exactly where the kernel reads address words', () => {
    const address = 'c0ffee00112233445566778899aabbccddeebeef'
    const words = addressWords(address)
    expect(addressWordsToHex(words)).toBe(address)
    const matches = (pre: string, suf: string) => {
      const { mask, value } = patternToMask(mergeAddressPattern(pre, suf, false).body)
      return words.every((w, i) => ((w & mask[i]) >>> 0) === value[i])
    }
    expect(matches('c0ffee', 'beef')).toBe(true)
    expect(matches('c0ffee0', '')).toBe(true)
    expect(matches('', 'f')).toBe(true)
    expect(matches('c0ffef', '')).toBe(false)
    expect(matches('', 'beee')).toBe(false)
    expect(matches(address, '')).toBe(true)
    // every single-nibble position, odd and even
    for (let n = 0; n < 40; n++) {
      const pre = address.slice(0, n) + ((parseInt(address[n], 16) + 1) % 16).toString(16)
      expect(matches(pre, ''), `nibble ${n}`).toBe(false)
    }
  })
})

describe('walker keys', () => {
  it('reconstructs s + counter*(2M+1) + offset modulo n', () => {
    const scalars = new Uint32Array(16)
    const s = CURVE_ORDER - 5n
    for (let i = 0; i < 8; i++) scalars[8 + i] = Number((s >> BigInt(32 * i)) & 0xffffffffn)
    expect(walkerPrivateKey(scalars, 1, 0, 3, 63)).toBe(CURVE_ORDER - 2n)
    expect(walkerPrivateKey(scalars, 1, 0, 6, 63)).toBe(1n)        // wraps past n
    expect(walkerPrivateKey(scalars, 1, 2, -7, 63)).toBe((s + 2n * 127n - 7n) % CURVE_ORDER)
  })

  it('draws valid, distinct private keys', () => {
    const scalars = randomScalars(256)
    const seen = new Set<bigint>()
    for (let i = 0; i < 256; i++) {
      const k = limbsToBigInt(scalars, i * 8)
      expect(k > 0n && k < CURVE_ORDER).toBe(true)
      seen.add(k)
    }
    expect(seen.size).toBe(256)
  })
})

describe('point tables', () => {
  const fe = (t: Uint32Array, o: number) => limbsToBigInt(t, o)

  it('search table holds i*G (with -y) and the (2M+1)*G advance step', () => {
    const m = 7
    const t = buildSearchTable(m)
    for (let i = 0; i < m; i++) {
      const { x, y } = secp.Point.BASE.multiply(BigInt(i + 1)).toAffine()
      expect(fe(t, i * 24)).toBe(x)
      expect(fe(t, i * 24 + 8)).toBe(y)
      expect(fe(t, i * 24 + 16)).toBe(P - y)
    }
    const adv = secp.Point.BASE.multiply(BigInt(2 * m + 1)).toAffine()
    expect(fe(t, m * 24)).toBe(adv.x)
  })

  it('comb table entry (w, v) is v * 16^w * G', () => {
    const t = buildCombTable()
    for (const [w, v] of [[0, 1], [0, 15], [1, 1], [17, 9], [63, 15]]) {
      const { x, y } = secp.Point.BASE.multiply(BigInt(v) * 16n ** BigInt(w)).toAffine()
      const o = (w * 15 + v - 1) * 16
      expect(fe(t, o), `x(${w},${v})`).toBe(x)
      expect(fe(t, o + 8), `y(${w},${v})`).toBe(y)
    }
  })

  it('a scalar decomposed over the comb reproduces k*G (what the init kernel sums)', () => {
    const t = buildCombTable()
    const k = limbsToBigInt(randomScalars(1), 0)
    let acc = secp.Point.ZERO
    for (let w = 0; w < 64; w++) {
      const v = Number((k >> BigInt(4 * w)) & 0xfn)
      if (v === 0) continue
      const o = (w * 15 + v - 1) * 16
      acc = acc.add(secp.Point.fromAffine({ x: fe(t, o), y: fe(t, o + 8) }))
    }
    const pub = secp.getPublicKey(Buffer.from(k.toString(16).padStart(64, '0'), 'hex'), false)
    expect(Buffer.from(acc.toBytes(false)).toString('hex')).toBe(Buffer.from(pub).toString('hex'))
    // sanity: the address the GPU would report is keccak(pub)[12:]
    expect(Buffer.from(keccak_256(pub.slice(1)).slice(12)).toString('hex')).toHaveLength(40)
  })
})
