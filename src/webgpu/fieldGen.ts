// secp256k1 field arithmetic (mod p = 2^256 - 2^32 - 977) over 8 little-endian
// u32 limbs, generated as straight-line code. Every function takes and returns
// fully reduced elements (< p). See codegen.ts for why this is generated.
import { Code, type Target } from './codegen'

const FE = 'array<u32, 8>'
const LIMBS = [0, 1, 2, 3, 4, 5, 6, 7]

type Pair = [string, string]

/** Split a limb into 16-bit halves (hoisted so each limb is split once). */
function halves(c: Code, x: string): Pair {
  return [c.tmp(x + 'l', c.and(x, c.lit(0xffff))), c.tmp(x + 'h', c.shr(x, 16))]
}

/** Full 32x32 -> 64 multiply from pre-split halves. Returns [lo, hi]. */
function mul32(c: Code, a: string, ah: Pair, b: string, bh: Pair): Pair {
  const [al, aH] = ah
  const [bl, bH] = bh
  const ll = c.tmp('ll', c.mul(al, bl))
  // Neither intermediate can overflow: (2^16-1)^2 + (2^16-1) < 2^32.
  const m1 = c.tmp('m1', c.add(c.mul(aH, bl), c.shr(ll, 16)))
  const m2 = c.tmp('m2', c.add(c.mul(al, bH), c.and(m1, c.lit(0xffff))))
  const hi = c.tmp('hi', c.add(c.add(c.mul(aH, bH), c.shr(m1, 16)), c.shr(m2, 16)))
  const lo = c.tmp('lo', c.mul(a, b)) // native u32 multiply already yields the low word
  return [lo, hi]
}

/** x * 977 as [lo, hi] (hi < 977). */
function mul977(c: Code, x: string): Pair {
  const lo = c.tmp('ul', c.mul(x, c.lit(977)))
  const part = c.add(c.mul(c.shr(x, 16), c.lit(977)), c.shr(c.mul(c.and(x, c.lit(0xffff)), c.lit(977)), 16))
  const hi = c.tmp('uh', c.shr(part, 16))
  return [lo, hi]
}

/**
 * Sum a column of u32 terms plus an optional incoming carry. Returns the low
 * word and the number of 2^32 wraps (the outgoing carry), which is exact
 * because each single addition of two u32 values wraps at most once.
 */
function column(c: Code, terms: string[], carryIn: string | null): Pair {
  const all = carryIn ? [...terms, carryIn] : terms
  let acc = all[0]
  let carry: string | null = null
  for (let i = 1; i < all.length; i++) {
    const s = c.tmp('s', c.add(acc, all[i]))
    const k = c.lt(s, all[i])
    carry = carry ? c.tmp('k', c.add(carry, k)) : c.tmp('k', k)
    acc = s
  }
  return [acc, carry ?? c.lit(0)]
}

/** 1 if the 8-limb value r is >= p, else 0. */
function geP(c: Code, r: string[]): string {
  const hiOnes = c.eq(c.and(c.and(c.and(r[7], r[6]), c.and(r[5], r[4])), c.and(r[3], r[2])), c.lit(0xffffffff))
  const lowGe = c.or(
    c.eq(r[1], c.lit(0xffffffff)),
    c.and(c.eq(r[1], c.lit(0xfffffffe)), c.xor(c.lt(r[0], c.lit(0xfffffc2f)), c.lit(1)))
  )
  return c.tmp('ge', c.and(hiOnes, lowGe))
}

/** r + (2^32 + 977) mod 2^256, i.e. r - p when r >= p. */
function addC(c: Code, r: string[]): string[] {
  const [t0, c0] = column(c, [r[0], c.lit(977)], null)
  const [t1, c1] = column(c, [r[1], c.lit(1)], c0)
  const out = [t0, t1]
  let carry = c1
  for (let i = 2; i < 8; i++) {
    const s = c.tmp('t', c.add(r[i], carry))
    if (i < 7) carry = c.tmp('k', c.lt(s, carry))
    out.push(s)
  }
  return out
}

/** Conditionally subtract p from a value already known to be < 2^256. */
function condSubP(c: Code, r: string[]): string[] {
  const ge = geP(c, r)
  // When r >= p, r - p < 2^32 + 977, so limbs 2..7 of the result are zero.
  const [s0, k0] = column(c, [r[0], c.lit(977)], null)
  const s1 = c.add(c.add(r[1], c.lit(1)), k0)
  return LIMBS.map(i => c.tmp('r', c.sel(ge, i === 0 ? s0 : i === 1 ? s1 : c.lit(0), r[i])))
}

/** Reduce a 512-bit product (16 limbs) mod p using 2^256 == 2^32 + 977. */
function reduce(c: Code, p: string[]): string[] {
  const L = p.slice(0, 8)
  const H = p.slice(8, 16)
  // Pass 1: t = L + H*977 + H*2^32  (< 2^289, so 9 limbs plus a 1-bit t9)
  const u = H.map(h => mul977(c, h))
  const t: string[] = []
  let carry: string | null = null
  for (let k = 0; k < 9; k++) {
    const terms: string[] = []
    if (k < 8) terms.push(L[k], u[k][0])
    if (k > 0) terms.push(u[k - 1][1], H[k - 1])
    const [s, k2]: Pair = column(c, terms, carry)
    t.push(s)
    carry = k2
  }
  const t8 = t[8]
  const t9 = carry! // 0 or 1
  // Pass 2: r = t[0..7] + (t9:t8) * (2^32 + 977)   (the folded part is < 2^66)
  const [vl, vh] = mul977(c, t8)
  const vh2 = c.tmp('vh', c.add(vh, c.mul(t9, c.lit(977))))
  const [r0, k0] = column(c, [t[0], vl], null)
  const [r1, k1] = column(c, [t[1], vh2, t8], k0)
  const [r2, k2] = column(c, [t[2], t9], k1)
  const r = [r0, r1, r2]
  let cy = k2
  for (let i = 3; i < 8; i++) {
    const s = c.tmp('r', c.add(t[i], cy))
    cy = c.tmp('k', c.lt(s, cy))
    r.push(s)
  }
  // A carry out of limb 7 means we wrapped past 2^256; the remainder is then
  // < 2^66, so adding back 2^32 + 977 only touches limbs 0..2 and cannot overflow.
  const [f0, fk0] = column(c, [r[0], c.mul(cy, c.lit(977))], null)
  const [f1, fk1] = column(c, [r[1], cy], fk0)
  const f2 = c.tmp('r', c.add(r[2], fk1))
  return condSubP(c, [f0, f1, f2, r[3], r[4], r[5], r[6], r[7]])
}

function loadLimbs(c: Code, name: string): string[] {
  return LIMBS.map(i => c.let(`${name}${i}`, `${name}[${i}]`))
}

/**
 * Add row x*b (x one limb) into the partial product `w` starting at limb
 * `at`. Undefined entries of `w` are zero. Writes w[at..at+8].
 */
function addRow(c: Code, w: Array<string | undefined>, at: number, x: string, xh: Pair, b: string[], bh: Pair[]) {
  let carry: string | null = null
  for (let j = 0; j < 8; j++) {
    const k = at + j
    const [lo, hi] = mul32(c, x, xh, b[j], bh[j])
    const terms = w[k] ? [w[k]!, lo] : [lo]
    const [s, kc] = terms.length === 1 && !carry ? [lo, c.lit(0)] : column(c, terms, carry)
    w[k] = s
    // carry_out = hi + wraps; the exact column total is < 2^64 so this fits.
    carry = c.tmp('c', c.add(hi, kc))
  }
  w[at + 8] = carry!
}

/**
 * fe_mul with `rows` rows of the schoolbook product per loop iteration
 * (8 = fully unrolled). Fewer rows per iteration make the function several
 * times smaller, which matters because GPU compilers inline every call site:
 * the unrolled form costs ~9 s of first-run shader build on some drivers.
 * The rolled form keeps everything in registers by sliding a window of
 * partial-product limbs and rotating the input/output limbs, instead of
 * indexing arrays with the loop counter.
 *
 * `iterations` is the loop bound expression. Drivers fully unroll a loop with
 * a constant bound (undoing the size win), so the shader passes a value it
 * reads from a uniform; the JS twin passes the constant 8 / rows.
 */
function genMul(c: Code, rows: number, iterations: string): string {
  if (8 % rows !== 0) throw new Error('rows must divide 8')
  return c.fn('fe_mul', [['a', FE], ['b', FE]], FE, () => {
    const b = loadLimbs(c, 'b')
    const bh = b.map(x => halves(c, x))
    if (rows === 8) {
      const a = loadLimbs(c, 'a')
      const p: Array<string | undefined> = new Array(16)
      for (let i = 0; i < 8; i++) addRow(c, p, i, a[i], halves(c, a[i]), b, bh)
      c.emit(`return ${c.array('u32', reduce(c, p as string[]))};`)
      return
    }
    const z = c.lit(0)
    const x = LIMBS.map(i => c.var(`x${i}`, `a[${i}]`)) // a, consumed `rows` limbs per iteration
    const r = LIMBS.map(i => c.var(`r${i}`, z))         // partial product limbs i.. i+7
    const o = LIMBS.map(i => c.var(`o${i}`, z))         // finished low limbs, shifted in from the top
    c.loop(iterations, () => {
      const w: Array<string | undefined> = [...r]
      for (let k = 0; k < rows; k++) addRow(c, w, k, x[k], halves(c, x[k]), b, bh)
      // The lowest `rows` limbs are now final: shift them into o, slide the window.
      const nextO = LIMBS.map(q => (q < 8 - rows ? o[q + rows] : w[q - (8 - rows)]!))
      const nextR = LIMBS.map(q => w[q + rows]!)
      const nextX = LIMBS.map(q => (q + rows < 8 ? x[q + rows] : z))
      const tmpO = nextO.map(v => c.tmp('no', v))
      const tmpR = nextR.map(v => c.tmp('nr', v))
      const tmpX = nextX.map(v => c.tmp('nx', v))
      LIMBS.forEach(q => { c.set(o[q], tmpO[q]); c.set(r[q], tmpR[q]); c.set(x[q], tmpX[q]) })
    }, 'row')
    c.emit(`return ${c.array('u32', reduce(c, [...o, ...r]))};`)
  })
}

function genSqr(c: Code): string {
  return c.fn('fe_sqr', [['a', FE]], FE, () => {
    const a = loadLimbs(c, 'a')
    const ah = a.map(x => halves(c, x))
    // Off-diagonal products a_i*a_j (i < j), accumulated once then doubled.
    const p: Array<string | undefined> = new Array(16)
    for (let i = 0; i < 7; i++) {
      let carry: string | null = null
      for (let j = i + 1; j < 8; j++) {
        const k = i + j
        const [lo, hi] = mul32(c, a[i], ah[i], a[j], ah[j])
        const terms = p[k] ? [p[k]!, lo] : [lo]
        const [s, kc] = terms.length === 1 && !carry ? [lo, c.lit(0)] : column(c, terms, carry)
        p[k] = s
        carry = c.tmp('c', c.add(hi, kc))
      }
      p[i + 8] = carry!
    }
    const z = c.lit(0)
    const cross = Array.from({ length: 16 }, (_, k) => p[k] ?? z)
    const dbl = cross.map((v, k) =>
      c.tmp('d', k === 0 ? c.shl(v, 1) : c.or(c.shl(v, 1), c.shr(cross[k - 1], 31))))
    // Add the diagonal squares a_i^2 at limbs 2i, 2i+1.
    const out: string[] = []
    let carry: string | null = null
    for (let i = 0; i < 8; i++) {
      const [lo, hi] = mul32(c, a[i], ah[i], a[i], ah[i])
      const [s0, k0] = column(c, [dbl[2 * i], lo], carry)
      const [s1, k1] = column(c, [dbl[2 * i + 1], hi], k0)
      out.push(s0, s1)
      carry = k1
    }
    const r = reduce(c, out)
    c.emit(`return ${c.array('u32', r)};`)
  })
}

function genAdd(c: Code): string {
  return c.fn('fe_add', [['a', FE], ['b', FE]], FE, () => {
    const a = loadLimbs(c, 'a')
    const b = loadLimbs(c, 'b')
    const s: string[] = []
    let carry: string | null = null
    for (let i = 0; i < 8; i++) {
      const [v, k] = column(c, [a[i], b[i]], carry)
      s.push(v)
      carry = k
    }
    // a + b < 2p: subtract p once if it overflowed 2^256 or is >= p.
    const over = c.tmp('ov', c.or(carry!, geP(c, s)))
    const t = addC(c, s)
    const r = LIMBS.map(i => c.tmp('r', c.sel(over, t[i], s[i])))
    c.emit(`return ${c.array('u32', r)};`)
  })
}

function genSub(c: Code): string {
  return c.fn('fe_sub', [['a', FE], ['b', FE]], FE, () => {
    const a = loadLimbs(c, 'a')
    const b = loadLimbs(c, 'b')
    const d: string[] = []
    let borrow: string | null = null
    for (let i = 0; i < 8; i++) {
      const d0 = c.tmp('d', c.sub(a[i], b[i]))
      const b0 = c.lt(a[i], b[i])
      if (borrow) {
        const d1 = c.tmp('d', c.sub(d0, borrow))
        borrow = c.tmp('b', c.or(b0, c.lt(d0, borrow)))
        d.push(d1)
      } else {
        borrow = c.tmp('b', b0)
        d.push(d0)
      }
    }
    // On borrow add p back, i.e. subtract 2^32 + 977 mod 2^256.
    const t0 = c.tmp('t', c.sub(d[0], c.lit(977)))
    let br = c.tmp('b', c.lt(d[0], c.lit(977)))
    const t1a = c.tmp('t', c.sub(d[1], c.lit(1)))
    const ba = c.lt(d[1], c.lit(1))
    const t1 = c.tmp('t', c.sub(t1a, br))
    br = c.tmp('b', c.or(ba, c.lt(t1a, br)))
    const t = [t0, t1]
    for (let i = 2; i < 8; i++) {
      t.push(c.tmp('t', c.sub(d[i], br)))
      if (i < 7) br = c.tmp('b', c.lt(d[i], br))
    }
    const r = LIMBS.map(i => c.tmp('r', c.sel(borrow!, t[i], d[i])))
    c.emit(`return ${c.array('u32', r)};`)
  })
}

/**
 * Inversion by Fermat (a^(p-2)) with libsecp256k1's addition chain: 255
 * squarings + 15 multiplications instead of ~256 + ~250. Powers are
 * a^(2^k - 1) for k = 1, 2, 3, 6, 9, 11, 22, 44, 88, 176, 220, 223.
 *
 * The chain is driven by a table rather than written out, so fe_sqr and
 * fe_mul each appear once: GPU compilers inline every call site, and 30
 * inlined copies of the unrolled multiply made the shader take seconds to build.
 */
const INV_CHAIN: Array<[src: number, squarings: number, mul: number, dst: number]> = [
  [0, 1, 0, 1], [1, 1, 0, 2], [2, 3, 2, 3], [3, 3, 2, 4], [4, 2, 1, 5], [5, 11, 5, 6],
  [6, 22, 6, 7], [7, 44, 7, 8], [8, 88, 8, 9], [9, 44, 7, 10], [10, 3, 2, 11],
  // assemble p-2 = [223 ones] 0 [22 ones] 0000 1 0 11 0 1
  [11, 23, 6, 11], [11, 5, 0, 11], [11, 3, 1, 11], [11, 2, 0, 11],
]

function genInv(c: Code): string {
  const col = (k: number) => INV_CHAIN.map(step => c.lit(step[k]))
  const table = (name: string, k: number) => c.target === 'wgsl'
    ? `const ${name} = array<u32, ${INV_CHAIN.length}>(${col(k).join(', ')});`
    : `const ${name} = [${col(k).join(', ')}];`
  const fn = c.fn('fe_inv', [['a', FE]], FE, () => {
    c.emit(c.target === 'wgsl' ? `var pw: array<${FE}, 12>;` : 'const pw = new Array(12);')
    c.set('pw[0]', 'a')
    c.loop(INV_CHAIN.length, () => {
      c.var('r', 'pw[INV_SRC[s]]')
      c.loop('INV_SQ[s]', () => c.set('r', 'fe_sqr(r)'))
      c.set('pw[INV_DST[s]]', 'fe_mul(r, pw[INV_MUL[s]])')
    }, 's')
    c.emit('return pw[11];')
  })
  return [table('INV_SRC', 0), table('INV_SQ', 1), table('INV_MUL', 2), table('INV_DST', 3), fn].join('\n')
}

export type FieldOptions = {
  /** Schoolbook rows per loop iteration in fe_mul (1, 2, 4 or 8 = unrolled). */
  mulRows?: number
  /**
   * WGSL only: name of a u32 holding 8 / mulRows at run time, used as the
   * rolled multiply's loop bound (see genMul). Defaults to the constant.
   */
  mulItersVar?: string
}

/** All field functions for the given target, in dependency order. */
export function generateField(target: Target, opts: FieldOptions = {}): string {
  const c = new Code(target)
  const rows = opts.mulRows ?? 8
  const iterations = target === 'wgsl' && opts.mulItersVar ? opts.mulItersVar : c.lit(8 / rows)
  return [genAdd(c), genSub(c), genMul(c, rows, iterations), genSqr(c), genInv(c)].join('\n\n')
}
