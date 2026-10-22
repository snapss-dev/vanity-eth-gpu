export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return '∞'
  if (n >= 1e15) return n.toExponential(1).replace('e+', 'e')
  if (n >= 1e12) return (n / 1e12).toFixed(1) + 'T'
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'
  return Math.round(n).toLocaleString('en-US')
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return '∞'
  if (seconds < 1) return '<1s'
  if (seconds < 60) return `${Math.round(seconds)}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`
  if (seconds < 31536000) return `${(seconds / 86400).toFixed(1)}d`
  return `${formatNumber(seconds / 31536000)}y`
}

/**
 * Seconds until a match has probability `p` of having turned up. The search is
 * memoryless (each key is an independent 1-in-D draw), so this is a quantile of
 * the exponential distribution: -ln(1-p) * D / speed.
 */
export function secondsForChance(difficulty: number, speed: number, p: number): number {
  if (speed <= 0) return Infinity
  return (-Math.log1p(-p) * difficulty) / speed
}

/** Probability that at least one match has turned up after `checked` keys. */
export function chanceFoundByNow(difficulty: number, checked: number): number {
  if (difficulty <= 0) return 1
  return -Math.expm1(-checked / difficulty)
}
