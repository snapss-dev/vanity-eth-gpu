// CPU search: the same algorithm as the GPU kernel (see webgpu/kernel.wgsl),
// running the same generated field arithmetic and Keccak compiled to JS.
// A walker at c*G checks c-M .. c+M with one batched inversion, then
// advances by 2M+1. A much larger M than on the GPU is fine here (no register
// pressure), which makes the inversion's share of the cost negligible.
import { eth_address, fe_add, fe_inv, fe_mul, fe_sqr, fe_sub } from 'virtual:cpu-kernel'
import { Point, utils } from '@noble/secp256k1'
import { addressWordsToHex, bigIntToHex32, buildSearchTable, CURVE_ORDER } from '../webgpu/precompute'
import { checksumAddress } from '../wallet/ethAddress'
import { addressMatchesRequest } from '../vanityResult'

export const CPU_TABLE_SIZE = 255

export type CpuSearchJob = {
  /** Address-word mask/value from patternToMask() (lowercase pattern). */
  mask: ArrayLike<number>
  value: ArrayLike<number>
  /** 0 = wallet, 1 = first CREATE contract. */
  mode: number
  /** The request as typed; only used to apply the EIP-55 case rule. */
  prefix: string
  suffix: string
  caseSensitive: boolean
}

export type CpuSearchResult = {
  checked: number
  /** A key whose address satisfies the request (callers still verify it). */
  found: { privHex: string; address: string } | null
}

type Fe = number[]
type Table = { x: Fe[]; y: Fe[]; ny: Fe[] }

const tables = new Map<number, Table>()

function getTable(m: number): Table {
  let t = tables.get(m)
  if (!t) {
    const raw = buildSearchTable(m)
    const fe = (o: number) => Array.from(raw.subarray(o, o + 8))
    t = { x: [], y: [], ny: [] }
    for (let i = 0; i <= m; i++) {
      t.x.push(fe(i * 24))
      t.y.push(fe(i * 24 + 8))
      t.ny.push(fe(i * 24 + 16))
    }
    tables.set(m, t)
  }
  return t
}

function toFe(v: bigint): Fe {
  const out = new Array<number>(8)
  for (let i = 0; i < 8; i++) out[i] = Number((v >> BigInt(32 * i)) & 0xffffffffn)
  return out
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let v = 0n
  for (const b of bytes) v = (v << 8n) | BigInt(b)
  return v
}

/**
 * Check at least `minPoints` keys starting from a fresh random key, returning
 * early on the first match. Each call starts from a new CSPRNG key, so results
 * from different calls are unrelated.
 */
export function searchBatch(job: CpuSearchJob, minPoints: number, m = CPU_TABLE_SIZE): CpuSearchResult {
  const t = getTable(m)
  const span = 2 * m + 1
  // Signed copies so the comparison below is plain int32 arithmetic.
  const m0 = job.mask[0] | 0, m1 = job.mask[1] | 0, m2 = job.mask[2] | 0, m3 = job.mask[3] | 0, m4 = job.mask[4] | 0
  const v0 = job.value[0] | 0, v1 = job.value[1] | 0, v2 = job.value[2] | 0, v3 = job.value[3] | 0, v4 = job.value[4] | 0
  const mode = job.mode

  let c = bytesToBigInt(utils.randomSecretKey())
  const start = Point.BASE.multiply(c).toAffine()
  let cx = toFe(start.x)
  let cy = toFe(start.y)
  const pref: Fe[] = new Array(m + 1)
  let checked = 0

  // Returns a result when (x, y) — the key c + offset — fully matches.
  const probe = (x: Fe, y: Fe, offset: number): CpuSearchResult | null => {
    const w = eth_address(x, y, mode)
    if ((w[0] & m0) !== v0 || (w[1] & m1) !== v1 || (w[2] & m2) !== v2 || (w[3] & m3) !== v3 || (w[4] & m4) !== v4) {
      return null
    }
    const address = checksumAddress(addressWordsToHex(w))
    // The pattern was matched case-insensitively; EIP-55 case is a further
    // 1-in-2-per-letter filter that's cheap enough to apply only to candidates.
    if (job.caseSensitive && !addressMatchesRequest(address, job.prefix, job.suffix, true)) return null
    let k = (c + BigInt(offset)) % CURVE_ORDER
    if (k < 0n) k += CURVE_ORDER
    return { checked: checked + span, found: { privHex: bigIntToHex32(k), address } }
  }

  while (checked < minPoints) {
    let acc = fe_sub(t.x[0], cx)
    pref[0] = acc
    for (let i = 1; i <= m; i++) {
      acc = fe_mul(acc, fe_sub(t.x[i], cx))
      pref[i] = acc
    }
    let inv = fe_inv(acc)
    let nx = cx
    let ny = cy
    for (let i = m; i >= 0; i--) {
      const qx = t.x[i]
      let z = inv
      if (i > 0) {
        z = fe_mul(inv, pref[i - 1])
        inv = fe_mul(inv, fe_sub(qx, cx))
      }
      const sx = fe_add(cx, qx)
      let lam = fe_mul(fe_sub(t.y[i], cy), z)
      let x3 = fe_sub(fe_sqr(lam), sx)
      let y3 = fe_sub(fe_mul(lam, fe_sub(cx, x3)), cy)
      if (i === m) {
        nx = x3 // the advance step (2M+1)*G
        ny = y3
        continue
      }
      const hitPlus = probe(x3, y3, i + 1)
      if (hitPlus) return hitPlus
      lam = fe_mul(fe_sub(t.ny[i], cy), z)
      x3 = fe_sub(fe_sqr(lam), sx)
      y3 = fe_sub(fe_mul(lam, fe_sub(cx, x3)), cy)
      const hitMinus = probe(x3, y3, -(i + 1))
      if (hitMinus) return hitMinus
    }
    const hitCentre = probe(cx, cy, 0)
    if (hitCentre) return hitCentre
    cx = nx
    cy = ny
    c += BigInt(span)
    checked += span
  }
  return { checked, found: null }
}
