// Vanity search kernels. The field arithmetic (fe_*), keccak256_17 and
// eth_address are generated (see fieldGen.ts / keccakGen.ts) and prepended.
//
// Every invocation owns one persistent "walker": an affine point C = c*G whose
// scalar c only the host knows. Each `search` dispatch checks the 2M+1 points
// C-M*G .. C+M*G, then advances C by (2M+1)*G. The M+1 inversions needed for
// those affine additions are batched (Montgomery's trick) into a single field
// inversion, and P+iG / P-iG share each inverse, so a point costs ~6 field
// multiplications instead of a full scalar multiplication.
//
// `init` turns a host-chosen random scalar into the walker's starting point with
// a fixed-base comb (64 mixed additions from a precomputed table of v*16^w*G).

alias Fe = array<u32, 8>;

const WG: u32 = __WG__u;
const M: u32 = __M__u;            // table points on each side of the centre
const M1: u32 = __M1__u;          // M + 1 batched inversions (incl. the advance)
const MAX_RESULTS: u32 = __MAX_RESULTS__u;
const RESULT_WORDS: u32 = 8u;     // walker, offset, counter, address[5]
const TABLE_WORDS: u32 = 24u;     // x, y, -y

struct SearchParams {
  base: u32,
  count: u32,
  mode: u32,
  mul_iters: u32,
  mask: array<vec4<u32>, 2>,      // address words 0..3 in [0], word 4 in [1].x
  value: array<vec4<u32>, 2>,
}

struct InitParams {
  base: u32,
  count: u32,
  mul_iters: u32,
  _pad: u32,
}

// fe_mul's loop count (8 / rows per iteration), copied from a uniform at entry.
// It's always the same value, but a bound the compiler can't see stops drivers
// from unrolling the rolled multiply back into one huge block per call site,
// which made the first shader build take ~9 s on some GPUs.
var<private> mul_iters: u32;

struct Results {
  count: atomic<u32>,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
  data: array<u32>,
}

@group(0) @binding(0) var<uniform> sp: SearchParams;
@group(0) @binding(1) var<storage, read_write> walkers: array<u32>;   // 16 words per walker: x, y
@group(0) @binding(2) var<storage, read_write> counters: array<u32>;  // advances per walker
@group(0) @binding(3) var<storage, read> table: array<u32>;           // i*G for i = 1..M, then (2M+1)*G
@group(0) @binding(4) var<storage, read_write> results: Results;
@group(0) @binding(5) var<uniform> ip: InitParams;
@group(0) @binding(6) var<storage, read> scalars: array<u32>;         // 8 words per walker
@group(0) @binding(7) var<storage, read> comb: array<u32>;            // 64 x 15 affine points

const FE_ONE = Fe(1u, 0u, 0u, 0u, 0u, 0u, 0u, 0u);

fn table_fe(o: u32) -> Fe {
  return Fe(table[o], table[o + 1u], table[o + 2u], table[o + 3u],
            table[o + 4u], table[o + 5u], table[o + 6u], table[o + 7u]);
}

fn comb_fe(o: u32) -> Fe {
  return Fe(comb[o], comb[o + 1u], comb[o + 2u], comb[o + 3u],
            comb[o + 4u], comb[o + 5u], comb[o + 6u], comb[o + 7u]);
}

fn matches(a: array<u32, 5>) -> bool {
  return (a[0] & sp.mask[0].x) == sp.value[0].x
      && (a[1] & sp.mask[0].y) == sp.value[0].y
      && (a[2] & sp.mask[0].z) == sp.value[0].z
      && (a[3] & sp.mask[0].w) == sp.value[0].w
      && (a[4] & sp.mask[1].x) == sp.value[1].x;
}

fn check(x: Fe, y: Fe, walker: u32, offset: i32, counter: u32) {
  let a = eth_address(x, y, sp.mode);
  if (!matches(a)) { return; }
  // Cheap guard so a trivially easy pattern can't hammer the atomic.
  if (atomicLoad(&results.count) >= MAX_RESULTS) { return; }
  let slot = atomicAdd(&results.count, 1u);
  if (slot >= MAX_RESULTS) { return; }
  let o = slot * RESULT_WORDS;
  results.data[o] = walker;
  results.data[o + 1u] = bitcast<u32>(offset);
  results.data[o + 2u] = counter;
  results.data[o + 3u] = a[0];
  results.data[o + 4u] = a[1];
  results.data[o + 5u] = a[2];
  results.data[o + 6u] = a[3];
  results.data[o + 7u] = a[4];
}

@compute @workgroup_size(WG)
fn search(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= sp.count) { return; }
  mul_iters = sp.mul_iters;
  let w = sp.base + gid.x;
  let so = w * 16u;
  let cx = Fe(walkers[so], walkers[so + 1u], walkers[so + 2u], walkers[so + 3u],
              walkers[so + 4u], walkers[so + 5u], walkers[so + 6u], walkers[so + 7u]);
  let cy = Fe(walkers[so + 8u], walkers[so + 9u], walkers[so + 10u], walkers[so + 11u],
              walkers[so + 12u], walkers[so + 13u], walkers[so + 14u], walkers[so + 15u]);
  let counter = counters[w];

  // Prefix products of dx_i = Q_i.x - C.x for the batched inversion.
  var pref: array<Fe, M1>;
  var acc = fe_sub(table_fe(0u), cx);
  pref[0] = acc;
  for (var i = 1u; i < M1; i = i + 1u) {
    acc = fe_mul(acc, fe_sub(table_fe(i * TABLE_WORDS), cx));
    pref[i] = acc;
  }
  var inv = fe_inv(acc);

  var nx = cx;
  var ny = cy;
  var i = M;
  loop {
    let o = i * TABLE_WORDS;
    let qx = table_fe(o);
    var z = inv;                       // 1/dx_i once the other factors are peeled off
    if (i > 0u) {
      z = fe_mul(inv, pref[i - 1u]);
      inv = fe_mul(inv, fe_sub(qx, cx));
    }
    let sx = fe_add(cx, qx);
    // side 0: C + Q_i; side 1: C - Q_i, which shares the inverse since -Q_i = (x, -y);
    // side 2 (last iteration only): C itself. Entry M is the advance step
    // (2M+1)*G and only needs the + side. One loop body keeps a single
    // inlined copy of eth_address (two Keccak permutations) in the shader.
    let sides = select(select(2u, 3u, i == 0u), 1u, i == M);
    for (var side = 0u; side < sides; side = side + 1u) {
      var x3 = cx;
      var y3 = cy;
      if (side < 2u) {
        let lam = fe_mul(fe_sub(table_fe(o + 8u + side * 8u), cy), z);
        x3 = fe_sub(fe_sqr(lam), sx);
        y3 = fe_sub(fe_mul(lam, fe_sub(cx, x3)), cy);
      }
      if (i == M) {
        nx = x3;
        ny = y3;
      } else {
        let k = i32(i + 1u);
        check(x3, y3, w, select(select(k, -k, side == 1u), 0, side == 2u), counter);
      }
    }
    if (i == 0u) { break; }
    i = i - 1u;
  }

  for (var k = 0u; k < 8u; k = k + 1u) {
    walkers[so + k] = nx[k];
    walkers[so + 8u + k] = ny[k];
  }
  counters[w] = counter + 1u;
}

// Jacobian (R0, R1, R2) += affine (R3, R4), 8M + 3S, as a list of
// (op, dst, a, b) register operations: op 0 = mul, 1 = sub, 2 = add.
// Interpreting a list instead of writing the formula out keeps one inlined
// copy of fe_mul in this entry point; init runs once per walker, so the
// register-file traffic doesn't matter, but shader build time does.
const MADD = array<vec4<u32>, 18>(
  vec4<u32>(0u, 5u, 2u, 2u),   // z1z1 = Z^2
  vec4<u32>(0u, 6u, 3u, 5u),   // u2 = qx * z1z1
  vec4<u32>(0u, 7u, 2u, 5u),   // Z^3
  vec4<u32>(0u, 7u, 4u, 7u),   // s2 = qy * Z^3
  vec4<u32>(1u, 6u, 6u, 0u),   // h = u2 - X
  vec4<u32>(1u, 7u, 7u, 1u),   // r = s2 - Y
  vec4<u32>(0u, 8u, 6u, 6u),   // hh = h^2
  vec4<u32>(0u, 9u, 6u, 8u),   // hhh = h * hh
  vec4<u32>(0u, 8u, 0u, 8u),   // v = X * hh            (X is dead after this)
  vec4<u32>(0u, 10u, 7u, 7u),  // r^2
  vec4<u32>(1u, 10u, 10u, 9u), // r^2 - hhh
  vec4<u32>(2u, 11u, 8u, 8u),  // 2v
  vec4<u32>(1u, 0u, 10u, 11u), // X3 = r^2 - hhh - 2v
  vec4<u32>(1u, 8u, 8u, 0u),   // v - X3
  vec4<u32>(0u, 8u, 7u, 8u),   // r * (v - X3)
  vec4<u32>(0u, 9u, 1u, 9u),   // Y * hhh
  vec4<u32>(1u, 1u, 8u, 9u),   // Y3 = r * (v - X3) - Y * hhh
  vec4<u32>(0u, 2u, 2u, 6u),   // Z3 = Z * h
);

@compute @workgroup_size(WG)
fn init(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= ip.count) { return; }
  mul_iters = ip.mul_iters;
  let w = ip.base + gid.x;
  var R: array<Fe, 12>;
  var empty = true;
  for (var win = 0u; win < 64u; win = win + 1u) {
    let v = (scalars[w * 8u + (win >> 3u)] >> ((win & 7u) * 4u)) & 0xFu;
    if (v == 0u) { continue; }
    let o = (win * 15u + (v - 1u)) * 16u;
    R[3] = comb_fe(o);
    R[4] = comb_fe(o + 8u);
    if (empty) {
      R[0] = R[3];
      R[1] = R[4];
      R[2] = FE_ONE;
      empty = false;
      continue;
    }
    for (var k = 0u; k < 18u; k = k + 1u) {
      let op = MADD[k];
      let a = R[op.z];
      let b = R[op.w];
      var r: Fe;
      if (op.x == 0u) {
        r = fe_mul(a, b);
      } else if (op.x == 1u) {
        r = fe_sub(a, b);
      } else {
        r = fe_add(a, b);
      }
      R[op.y] = r;
    }
  }
  // Affine: x = X / Z^2, y = Y / Z^3.
  let zi = fe_inv(R[2]);
  R[5] = zi;
  const FIN = array<vec3<u32>, 4>(
    vec3<u32>(6u, 5u, 5u),     // zi^2
    vec3<u32>(7u, 6u, 5u),     // zi^3
    vec3<u32>(0u, 0u, 6u),     // x
    vec3<u32>(1u, 1u, 7u),     // y
  );
  for (var k = 0u; k < 4u; k = k + 1u) {
    R[FIN[k].x] = fe_mul(R[FIN[k].y], R[FIN[k].z]);
  }
  let so = w * 16u;
  for (var k = 0u; k < 8u; k = k + 1u) {
    walkers[so + k] = R[0][k];
    walkers[so + 8u + k] = R[1][k];
  }
  counters[w] = 0u;
}
