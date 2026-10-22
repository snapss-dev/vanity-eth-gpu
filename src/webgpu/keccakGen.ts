// Keccak-256 for one 136-byte block, generated with every lane in a named
// variable (25 lanes x 2 u32 halves) so nothing is runtime-indexed.
import { Code, type Target } from './codegen'

/** Canonical Keccak-f[1600] round constants. */
export const KECCAK_RC: readonly bigint[] = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
]

/** Rotation offsets r[x][y]. */
const ROT = [
  [0, 36, 3, 41, 18],
  [1, 44, 10, 45, 2],
  [62, 6, 43, 15, 61],
  [28, 55, 25, 21, 56],
  [27, 20, 39, 8, 14],
]

type Lane = [string, string] // [lo, hi]

function rotl(c: Code, [lo, hi]: Lane, n: number): Lane {
  if (n === 0) return [lo, hi]
  if (n === 32) return [hi, lo]
  if (n < 32) {
    return [c.or(c.shl(lo, n), c.shr(hi, 32 - n)), c.or(c.shl(hi, n), c.shr(lo, 32 - n))]
  }
  const m = n - 32
  return [c.or(c.shl(hi, m), c.shr(lo, 32 - m)), c.or(c.shl(lo, m), c.shr(hi, 32 - m))]
}

const word = (x: number, y: number, half: 0 | 1) => `s${2 * (x + 5 * y) + half}`

/**
 * keccak256_17(m): Keccak-256 of a message that fits in the first 17 words of
 * the block, with the 0x01 domain/padding byte already placed by the caller.
 * The final 0x80 padding bit (byte 135) is applied here. Returns hash words
 * 3..7, i.e. hash bytes 12..31 — exactly the 20 bytes of an Ethereum address.
 */
function genKeccak(c: Code): string {
  return c.fn('keccak256_17', [['m', 'array<u32, 17>']], 'array<u32, 5>', () => {
    for (let w = 0; w < 50; w++) {
      const init = w < 17 ? `m[${w}]` : w === 33 ? c.lit(0x80000000) : c.lit(0)
      c.var(`s${w}`, init)
    }
    c.loop(24, () => {
      // θ
      const C: Lane[] = []
      for (let x = 0; x < 5; x++) {
        const half = (h: 0 | 1) => {
          let e = word(x, 0, h)
          for (let y = 1; y < 5; y++) e = c.xor(e, word(x, y, h))
          return c.let(`c${x}${h ? 'h' : 'l'}`, e)
        }
        C.push([half(0), half(1)])
      }
      const D: Lane[] = []
      for (let x = 0; x < 5; x++) {
        const r = rotl(c, C[(x + 1) % 5], 1)
        const l = C[(x + 4) % 5]
        D.push([c.let(`d${x}l`, c.xor(l[0], r[0])), c.let(`d${x}h`, c.xor(l[1], r[1]))])
      }
      // ρ and π: B[y][2x+3y] = rotl(A[x][y] ^ D[x], r[x][y])
      const B: Lane[][] = Array.from({ length: 5 }, () => new Array<Lane>(5))
      for (let x = 0; x < 5; x++) {
        for (let y = 0; y < 5; y++) {
          const a: Lane = [c.xor(word(x, y, 0), D[x][0]), c.xor(word(x, y, 1), D[x][1])]
          const ax: Lane = [c.let(`e${x}${y}l`, a[0]), c.let(`e${x}${y}h`, a[1])]
          const [lo, hi] = rotl(c, ax, ROT[x][y])
          const X = y
          const Y = (2 * x + 3 * y) % 5
          B[X][Y] = [c.let(`b${X}${Y}l`, lo), c.let(`b${X}${Y}h`, hi)]
        }
      }
      // χ
      for (let x = 0; x < 5; x++) {
        for (let y = 0; y < 5; y++) {
          for (const h of [0, 1] as const) {
            const b0 = B[x][y][h]
            const b1 = B[(x + 1) % 5][y][h]
            const b2 = B[(x + 2) % 5][y][h]
            c.set(word(x, y, h), c.xor(b0, c.and(c.not(b1), b2)))
          }
        }
      }
      // ι
      c.set('s0', c.xor('s0', 'RC_LO[j]'))
      c.set('s1', c.xor('s1', 'RC_HI[j]'))
    })
    c.emit(`return ${c.array('u32', ['s3', 's4', 's5', 's6', 's7'])};`)
  })
}

/**
 * eth_address(x, y, mode): address words (hash bytes 12..31 as 5 LE u32) for
 * the affine public key (x, y). mode 0 = the wallet itself; mode 1 = the
 * wallet's first CREATE contract, keccak256(rlp([wallet, 0])) =
 * keccak256(0xd6 0x94 <20-byte wallet> 0x80).
 */
function genAddress(c: Code): string {
  const FE = 'array<u32, 8>'
  return c.fn('eth_address', [['x', FE], ['y', FE], ['mode', 'u32']], 'array<u32, 5>', () => {
    // The public key is hashed as 64 big-endian bytes; limbs are little-endian
    // u32s, so reverse the limb order and byte-swap each limb.
    const bswap = (v: string) => c.or(
      c.or(c.shl(v, 24), c.shl(c.and(v, c.lit(0xff00)), 8)),
      c.or(c.and(c.shr(v, 8), c.lit(0xff00)), c.shr(v, 24)))
    const words: string[] = []
    for (const p of ['x', 'y']) {
      for (let i = 7; i >= 0; i--) words.push(c.tmp('w', bswap(`${p}[${i}]`)))
    }
    words.push(c.lit(1)) // 0x01 padding byte right after the 64-byte message
    c.var('msg', c.array('u32', words))
    c.var('h', c.array('u32', ['0', '0', '0', '0', '0'].map(() => c.lit(0))))
    // One hash per pass (a loop rather than two calls keeps a single inlined
    // copy of the permutation in the shader).
    c.loop(c.add('mode', c.lit(1)), () => {
      c.set('h', 'keccak256_17(msg)')
      // Next message: d6 94 a0..a19 80 01, with a0..a19 = h words 0..4 (LE).
      const h = (i: number) => `h[${i}]`
      const cw = [
        c.or(c.lit(0x94d6), c.shl(h(0), 16)),
        c.or(c.shr(h(0), 16), c.shl(h(1), 16)),
        c.or(c.shr(h(1), 16), c.shl(h(2), 16)),
        c.or(c.shr(h(2), 16), c.shl(h(3), 16)),
        c.or(c.shr(h(3), 16), c.shl(h(4), 16)),
        c.or(c.shr(h(4), 16), c.lit(0x01800000)),
      ]
      while (cw.length < 17) cw.push(c.lit(0))
      c.set('msg', c.array('u32', cw))
    }, 'round')
    c.emit('return h;')
  })
}

function rcTables(target: Target): string {
  const lo = KECCAK_RC.map(v => '0x' + (v & 0xffffffffn).toString(16).padStart(8, '0'))
  const hi = KECCAK_RC.map(v => '0x' + (v >> 32n).toString(16).padStart(8, '0'))
  if (target === 'wgsl') {
    return `const RC_LO = array<u32, 24>(${lo.map(v => v + 'u').join(', ')});\n` +
      `const RC_HI = array<u32, 24>(${hi.map(v => v + 'u').join(', ')});`
  }
  return `const RC_LO = [${lo.join(', ')}];\nconst RC_HI = [${hi.join(', ')}];`
}

export function generateKeccak(target: Target): string {
  const c = new Code(target)
  return [rcTables(target), genKeccak(c), genAddress(c)].join('\n\n')
}
