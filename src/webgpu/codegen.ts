// Dual-target code generator for the GPU kernel's hot paths.
//
// The secp256k1 field arithmetic and Keccak-f are emitted as fully unrolled,
// straight-line code (no runtime-indexed arrays, so GPU compilers keep every
// limb in registers). The same generator also emits an equivalent JavaScript
// "twin" with exact u32 wraparound semantics, which the Node test-suite runs
// against BigInt / @noble. That way the logic that ends up in the shader is
// exercised exhaustively without a GPU, and the GPU self-test only has to
// catch driver/compiler problems.

export type Target = 'wgsl' | 'js'

export class Code {
  private lines: string[] = []
  private depth = 1
  private uid = 0

  readonly target: Target

  constructor(target: Target) {
    this.target = target
  }

  // ── expressions (all operands and results are u32) ──
  lit(n: number): string {
    const v = n >>> 0
    const s = v > 9 ? '0x' + v.toString(16).toUpperCase() : String(v)
    return this.target === 'wgsl' ? s + 'u' : s
  }
  add(a: string, b: string): string { return this.target === 'wgsl' ? `(${a} + ${b})` : `((${a} + ${b}) >>> 0)` }
  sub(a: string, b: string): string { return this.target === 'wgsl' ? `(${a} - ${b})` : `((${a} - ${b}) >>> 0)` }
  mul(a: string, b: string): string { return this.target === 'wgsl' ? `(${a} * ${b})` : `(Math.imul(${a}, ${b}) >>> 0)` }
  shl(a: string, n: number): string { return this.target === 'wgsl' ? `(${a} << ${n}u)` : `((${a} << ${n}) >>> 0)` }
  shr(a: string, n: number): string { return this.target === 'wgsl' ? `(${a} >> ${n}u)` : `(${a} >>> ${n})` }
  and(a: string, b: string): string { return this.target === 'wgsl' ? `(${a} & ${b})` : `((${a} & ${b}) >>> 0)` }
  or(a: string, b: string): string { return this.target === 'wgsl' ? `(${a} | ${b})` : `((${a} | ${b}) >>> 0)` }
  xor(a: string, b: string): string { return this.target === 'wgsl' ? `(${a} ^ ${b})` : `((${a} ^ ${b}) >>> 0)` }
  not(a: string): string { return this.target === 'wgsl' ? `(~${a})` : `((~${a}) >>> 0)` }
  /** 1 if a < b else 0 */
  lt(a: string, b: string): string { return this.target === 'wgsl' ? `select(0u, 1u, ${a} < ${b})` : `(${a} < ${b} ? 1 : 0)` }
  /** 1 if a == b else 0 */
  eq(a: string, b: string): string { return this.target === 'wgsl' ? `select(0u, 1u, ${a} == ${b})` : `(${a} === ${b} ? 1 : 0)` }
  /** cond is a 0/1 u32 expression */
  sel(cond: string, ifTrue: string, ifFalse: string): string {
    return this.target === 'wgsl' ? `select(${ifFalse}, ${ifTrue}, ${cond} != 0u)` : `(${cond} ? ${ifTrue} : ${ifFalse})`
  }

  // ── statements ──
  fresh(prefix: string): string { return `${prefix}_${this.uid++}` }
  let(name: string, expr: string): string {
    this.emit(this.target === 'wgsl' ? `let ${name} = ${expr};` : `const ${name} = ${expr};`)
    return name
  }
  /** Bind an expression to a fresh immutable name and return the name. */
  tmp(prefix: string, expr: string): string { return this.let(this.fresh(prefix), expr) }
  var(name: string, expr: string): string {
    this.emit(this.target === 'wgsl' ? `var ${name} = ${expr};` : `let ${name} = ${expr};`)
    return name
  }
  set(name: string, expr: string): void { this.emit(`${name} = ${expr};`) }
  emit(line: string): void { this.lines.push('  '.repeat(this.depth) + line) }
  comment(text: string): void { this.emit('// ' + text) }

  /** count: a constant, or an expression already valid in the target language. */
  loop(count: number | string, body: () => void, counter = 'j'): void {
    const bound = typeof count === 'number' ? this.lit(count) : count
    this.emit(this.target === 'wgsl'
      ? `for (var ${counter} = 0u; ${counter} < ${bound}; ${counter} = ${counter} + 1u) {`
      : `for (let ${counter} = 0; ${counter} < ${bound}; ${counter}++) {`)
    this.depth++
    body()
    this.depth--
    this.emit('}')
  }

  /** Wrap the emitted body into a function definition and reset the buffer. */
  fn(name: string, params: Array<[string, string]>, returns: string, body: () => void): string {
    this.lines = []
    this.depth = 1
    this.uid = 0
    body()
    const head = this.target === 'wgsl'
      ? `fn ${name}(${params.map(([n, t]) => `${n}: ${t}`).join(', ')}) -> ${returns} {`
      : `function ${name}(${params.map(([n]) => n).join(', ')}) {`
    return [head, ...this.lines, '}'].join('\n')
  }

  /** Array value constructor, e.g. Fe(r0..r7). */
  array(elemType: string, items: string[]): string {
    return this.target === 'wgsl' ? `array<${elemType}, ${items.length}>(${items.join(', ')})` : `[${items.join(', ')}]`
  }
}
