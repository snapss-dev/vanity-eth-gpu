import kernelSource from './kernel.wgsl?raw'
import { generateField } from './fieldGen'
import { generateKeccak } from './keccakGen'

export type KernelConfig = {
  /** Invocations per workgroup. */
  workgroupSize: number
  /** M: table points on each side of a walker's centre (2M+1 points per dispatch). */
  tableSize: number
  /** Capacity of the per-dispatch results buffer. */
  maxResults: number
  /** fe_mul rows per loop iteration: 8 = fully unrolled (fastest, slowest to build). */
  mulRows: number
}

export const RESULT_WORDS = 8
export const RESULTS_HEADER_WORDS = 4

export function resultsBufferBytes(cfg: KernelConfig): number {
  return (RESULTS_HEADER_WORDS + cfg.maxResults * RESULT_WORDS) * 4
}

export function buildShader(cfg: KernelConfig): string {
  const generated = generateField('wgsl', { mulRows: cfg.mulRows, mulItersVar: 'mul_iters' }) + '\n\n' + generateKeccak('wgsl')
  const kernel = kernelSource
    .replace('__WG__', String(cfg.workgroupSize))
    .replace('__M__', String(cfg.tableSize))
    .replace('__M1__', String(cfg.tableSize + 1))
    .replace('__MAX_RESULTS__', String(cfg.maxResults))
  return generated + '\n\n' + kernel
}
