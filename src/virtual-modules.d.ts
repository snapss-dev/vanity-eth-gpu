// Generated at build time by the cpu-kernel plugin in vite.config.ts.
declare module 'virtual:cpu-kernel' {
  type Fe = number[]
  export function fe_add(a: Fe, b: Fe): Fe
  export function fe_sub(a: Fe, b: Fe): Fe
  export function fe_mul(a: Fe, b: Fe): Fe
  export function fe_sqr(a: Fe): Fe
  export function fe_inv(a: Fe): Fe
  export function keccak256_17(m: number[]): number[]
  /** Address words (hash bytes 12..31, 5 LE u32); mode 0 = wallet, 1 = first contract. */
  export function eth_address(x: Fe, y: Fe, mode: number): number[]
}
