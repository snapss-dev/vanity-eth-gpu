import { searchBatch, type CpuSearchJob } from './cpuSearch'

/**
 * SECURITY MODEL:
 * - Randomness: every batch starts from a fresh key from crypto.getRandomValues()
 *   (OS CSPRNG) via @noble/secp256k1's randomSecretKey (rejection-sampled, no bias).
 * - Within a batch, keys are k, k±1, k±2, ... which is safe: recovering any of
 *   them from an address is the discrete-log problem, and only the one matching
 *   key is ever returned.
 * - The main thread re-derives every returned key with @noble before showing it.
 */

type SearchMessage = { id: number; job: CpuSearchJob; minPoints: number }

self.onmessage = (e: MessageEvent<SearchMessage>) => {
  const { id, job, minPoints } = e.data
  try {
    self.postMessage({ id, ...searchBatch(job, minPoints) })
  } catch (err) {
    self.postMessage({ id, error: err instanceof Error ? err.message : String(err) })
  }
}
