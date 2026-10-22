// Host-side math for the GPU search: constant point tables, the walkers' random
// starting scalars, and turning a GPU hit back into its private key.
import { Point } from '@noble/secp256k1'
import { ADDRESS_NIBBLE_LENGTH } from '../searchPattern'

const { p: P, n: N } = Point.CURVE()

export const CURVE_ORDER = N

function writeFe(out: Uint32Array, offset: number, v: bigint) {
  for (let i = 0; i < 8; i++) out[offset + i] = Number((v >> BigInt(32 * i)) & 0xffffffffn)
}

export function limbsToBigInt(limbs: Uint32Array, offset: number): bigint {
  let v = 0n
  for (let i = 7; i >= 0; i--) v = (v << 32n) | BigInt(limbs[offset + i])
  return v
}

/**
 * Search table: entries 0..M-1 hold (i+1)*G as (x, y, -y); entry M holds the
 * advance step (2M+1)*G. 24 words per entry.
 */
export function buildSearchTable(m: number): Uint32Array<ArrayBuffer> {
  const out = new Uint32Array((m + 1) * 24)
  let q = Point.BASE
  for (let i = 0; i < m; i++) {
    const { x, y } = q.toAffine()
    writeFe(out, i * 24, x)
    writeFe(out, i * 24 + 8, y)
    writeFe(out, i * 24 + 16, P - y)
    q = q.add(Point.BASE)
  }
  const { x, y } = Point.BASE.multiply(BigInt(2 * m + 1)).toAffine()
  writeFe(out, m * 24, x)
  writeFe(out, m * 24 + 8, y)
  writeFe(out, m * 24 + 16, P - y)
  return out
}

/** Fixed-base comb: entry (w, v) = v * 16^w * G for w < 64, v = 1..15; 16 words each. */
export function buildCombTable(): Uint32Array<ArrayBuffer> {
  const out = new Uint32Array(64 * 15 * 16)
  let base = Point.BASE
  for (let w = 0; w < 64; w++) {
    let q = base
    for (let v = 1; v <= 15; v++) {
      const { x, y } = q.toAffine()
      const o = (w * 15 + v - 1) * 16
      writeFe(out, o, x)
      writeFe(out, o + 8, y)
      q = q.add(base)
    }
    base = q // 16 * base
  }
  return out
}

const N_TOP = Number(N >> 224n) // 0xFFFFFFFF

/**
 * `count` independent uniformly random private keys in [1, n), as 8
 * little-endian u32 limbs each, from the platform CSPRNG.
 */
export function randomScalars(count: number): Uint32Array<ArrayBuffer> {
  const out = new Uint32Array(count * 8)
  const CHUNK = 16384 // getRandomValues caps a single call at 65536 bytes
  for (let o = 0; o < out.length; o += CHUNK) crypto.getRandomValues(out.subarray(o, Math.min(o + CHUNK, out.length)))
  for (let i = 0; i < count; i++) {
    // Rejection sampling; a redraw is needed with probability ~2^-128.
    for (;;) {
      const s = out.subarray(i * 8, i * 8 + 8)
      if (s[7] < N_TOP) {
        if (s.some(v => v !== 0)) break
      } else {
        const v = limbsToBigInt(out, i * 8)
        if (v !== 0n && v < N) break
      }
      crypto.getRandomValues(s)
    }
  }
  return out
}

/** Private key of the point a walker reported: s + counter*(2M+1) + offset (mod n). */
export function walkerPrivateKey(scalars: Uint32Array, walker: number, counter: number, offset: number, m: number): bigint {
  const s = limbsToBigInt(scalars, walker * 8)
  const k = (s + BigInt(counter) * BigInt(2 * m + 1) + BigInt(offset)) % N
  return k < 0n ? k + N : k
}

export function bigIntToHex32(v: bigint): string {
  return v.toString(16).padStart(64, '0')
}

/**
 * Turn a lowercase nibble pattern (40 entries, null = any) into the mask/value
 * words the kernel compares against the address words (hash bytes 12..31 as
 * five little-endian u32s).
 */
export function patternToMask(body: ReadonlyArray<string | null>): { mask: Uint32Array; value: Uint32Array } {
  if (body.length !== ADDRESS_NIBBLE_LENGTH) throw new Error('pattern must have 40 nibbles')
  const mask = new Uint32Array(5)
  const value = new Uint32Array(5)
  for (let n = 0; n < ADDRESS_NIBBLE_LENGTH; n++) {
    const ch = body[n]
    if (ch === null) continue
    const nib = parseInt(ch, 16)
    if (Number.isNaN(nib)) throw new Error(`bad nibble ${ch}`)
    const byte = n >> 1
    const shift = (byte & 3) * 8 + (n & 1 ? 0 : 4)
    mask[byte >> 2] |= 0xf << shift
    value[byte >> 2] |= nib << shift
  }
  return { mask, value }
}

/** The 40-char lowercase hex address from five little-endian address words. */
export function addressWordsToHex(words: ArrayLike<number>): string {
  let out = ''
  for (let w = 0; w < 5; w++) {
    for (let b = 0; b < 4; b++) out += ((words[w] >>> (8 * b)) & 0xff).toString(16).padStart(2, '0')
  }
  return out
}
