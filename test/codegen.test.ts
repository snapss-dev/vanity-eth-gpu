// The GPU kernel's field arithmetic and Keccak are generated code. The generator
// also emits a JavaScript twin with exact u32 semantics; these tests run that
// twin against BigInt and @noble, so the shader logic is covered without a GPU.
import { describe, it, expect } from 'vitest'
import * as secp from '@noble/secp256k1'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { generateField } from '../src/webgpu/fieldGen'
import { generateKeccak, KECCAK_RC } from '../src/webgpu/keccakGen'
import { firstContractAddressFromWalletHex } from '../src/wallet/ethAddress'

type Fe = number[]
type Twin = {
  fe_add(a: Fe, b: Fe): Fe
  fe_sub(a: Fe, b: Fe): Fe
  fe_mul(a: Fe, b: Fe): Fe
  fe_sqr(a: Fe): Fe
  fe_inv(a: Fe): Fe
  keccak256_17(m: number[]): number[]
  eth_address(x: Fe, y: Fe, mode: number): number[]
}

function buildTwin(mulRows: number): Twin {
  return new Function(
    generateField('js', { mulRows }) + '\n' + generateKeccak('js') +
    '\nreturn { fe_add, fe_sub, fe_mul, fe_sqr, fe_inv, keccak256_17, eth_address }'
  )() as Twin
}
const twin = buildTwin(8)

const P = secp.Point.CURVE().p
const N = secp.Point.CURVE().n

const toFe = (v: bigint): Fe => Array.from({ length: 8 }, (_, i) => Number((v >> BigInt(32 * i)) & 0xffffffffn))
const fromFe = (f: Fe): bigint => f.reduceRight((acc, limb) => (acc << 32n) | BigInt(limb >>> 0), 0n)
const mod = (v: bigint) => ((v % P) + P) % P

// Deterministic PRNG so failures are reproducible.
let seed = 0x9e3779b9
function rnd32(): number {
  seed ^= seed << 13; seed >>>= 0
  seed ^= seed >>> 17
  seed ^= seed << 5; seed >>>= 0
  return seed
}
function randBelow(limit: bigint): bigint {
  let v = 0n
  for (let i = 0; i < 8; i++) v = (v << 32n) | BigInt(rnd32())
  return v % limit
}
// Values that stress carries and the reduction: near 0, near p, sparse/dense limbs.
const EDGE: bigint[] = [
  0n, 1n, 2n, 977n, 0x1000003d1n, P - 1n, P - 2n, P - 977n, P - 0x1000003d1n,
  (1n << 255n), (1n << 255n) - 1n, (1n << 224n) - 1n, (1n << 32n) - 1n, (1n << 64n) - 1n,
  P >> 1n, (P >> 1n) + 1n, BigInt('0x' + 'ffffffff00000000'.repeat(4)) % P,
  BigInt('0x' + '00000000ffffffff'.repeat(4)), BigInt('0x' + '8000000000000000'.repeat(4)),
]

function samples(count: number): bigint[] {
  const out = [...EDGE]
  for (let i = 0; i < count; i++) out.push(randBelow(P))
  return out
}

describe('generated field arithmetic (JS twin of the WGSL)', () => {
  const xs = samples(300)

  it('fe_mul / fe_sqr match BigInt over edge cases and random pairs', () => {
    let fails = 0
    for (const a of xs) {
      for (const b of EDGE) if (fromFe(twin.fe_mul(toFe(a), toFe(b))) !== mod(a * b)) fails++
      if (fromFe(twin.fe_sqr(toFe(a))) !== mod(a * a)) fails++
    }
    for (let i = 0; i < 20000; i++) {
      const a = randBelow(P), b = randBelow(P)
      if (fromFe(twin.fe_mul(toFe(a), toFe(b))) !== mod(a * b)) fails++
      if (fromFe(twin.fe_sqr(toFe(a))) !== mod(a * a)) fails++
    }
    expect(fails).toBe(0)
  })

  for (const rows of [1, 2, 4]) {
    it(`rolled fe_mul (${rows} row(s) per iteration) matches BigInt`, () => {
      const rolled = buildTwin(rows)
      let fails = 0
      for (const a of xs) for (const b of EDGE) if (fromFe(rolled.fe_mul(toFe(a), toFe(b))) !== mod(a * b)) fails++
      for (let i = 0; i < 5000; i++) {
        const a = randBelow(P), b = randBelow(P)
        if (fromFe(rolled.fe_mul(toFe(a), toFe(b))) !== mod(a * b)) fails++
      }
      expect(fails).toBe(0)
    })
  }

  it('fe_add / fe_sub match BigInt and always return reduced values', () => {
    let fails = 0
    for (const a of xs) {
      for (const b of xs.slice(0, 60)) {
        const s = fromFe(twin.fe_add(toFe(a), toFe(b)))
        const d = fromFe(twin.fe_sub(toFe(a), toFe(b)))
        if (s !== mod(a + b) || s >= P) fails++
        if (d !== mod(a - b) || d >= P) fails++
      }
    }
    expect(fails).toBe(0)
  })

  it('fe_inv is the modular inverse (and maps 0 to 0)', () => {
    expect(fromFe(twin.fe_inv(toFe(0n)))).toBe(0n)
    for (const a of [...EDGE.filter(v => v !== 0n), ...samples(40).slice(EDGE.length)]) {
      const inv = fromFe(twin.fe_inv(toFe(a)))
      expect(mod(inv * a), `a=${a.toString(16)}`).toBe(1n)
    }
  })
})

function wordsToBytes(words: number[]): Uint8Array {
  const out = new Uint8Array(words.length * 4)
  words.forEach((w, i) => { for (let b = 0; b < 4; b++) out[i * 4 + b] = (w >>> (8 * b)) & 0xff })
  return out
}
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')

describe('generated Keccak-256 (JS twin of the WGSL)', () => {
  it('uses the canonical round constants', () => {
    expect(KECCAK_RC.length).toBe(24)
    // RC[i] is defined by an LFSR; recompute it independently.
    let r = 1
    const lfsr = () => { const bit = r & 1; r = (r << 1) ^ ((r & 0x80) ? 0x171 : 0); return bit }
    for (let i = 0; i < 24; i++) {
      let rc = 0n
      for (let j = 0; j < 7; j++) if (lfsr()) rc |= 1n << BigInt((1 << j) - 1)
      expect(KECCAK_RC[i], `RC[${i}]`).toBe(rc)
    }
  })

  it('matches @noble keccak_256 for 64-byte (public key) messages', () => {
    for (let t = 0; t < 300; t++) {
      const m = Array.from({ length: 17 }, (_, i) => (i < 16 ? rnd32() : 1))
      const msg = wordsToBytes(m.slice(0, 16))
      expect(hex(wordsToBytes(twin.keccak256_17(m)))).toBe(hex(keccak_256(msg).slice(12)))
    }
  })

  it('derives wallet and first-contract addresses exactly like the reference code', () => {
    for (let t = 0; t < 120; t++) {
      const k = t < 3 ? BigInt(t + 1) : (t === 3 ? N - 1n : randBelow(N - 1n) + 1n)
      const { x, y } = secp.Point.BASE.multiply(k).toAffine()
      const pub = new Uint8Array(64)
      for (let i = 0; i < 32; i++) {
        pub[i] = Number((x >> BigInt(8 * (31 - i))) & 0xffn)
        pub[32 + i] = Number((y >> BigInt(8 * (31 - i))) & 0xffn)
      }
      const wallet = hex(keccak_256(pub).slice(12))
      expect(hex(wordsToBytes(twin.eth_address(toFe(x), toFe(y), 0)))).toBe(wallet)
      expect(hex(wordsToBytes(twin.eth_address(toFe(x), toFe(y), 1)))).toBe(firstContractAddressFromWalletHex(wallet))
    }
  })
})
