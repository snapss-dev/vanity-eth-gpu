# Vanity ETH GPU

A fast Ethereum vanity address generator that runs entirely in your browser.

## Features

- **GPU-accelerated** - A WebGPU compute kernel (secp256k1 + Keccak-256) generates and matches addresses directly on the GPU: ~900M addresses/s on an RTX 3080 Ti, ~12M/s on a laptop iGPU
- **Starts instantly** - The search begins on CPU workers while the GPU kernel builds, then moves to the GPU the moment it passes its self-test
- **Multi-GPU** - Runs a parallel search on every GPU the browser exposes (e.g. integrated + discrete)
- **Verified results** - The GPU runs a known-answer self-test before it is trusted, and every match is re-derived from the private key with @noble before it is shown or exported, so a miscomputation can never surface a wrong address
- **Privacy First** - All computations run locally in your browser; the production Content Security Policy forbids the page and its workers from opening network connections
- **Custom Prefix/Suffix** - Find addresses starting or ending with your desired characters, optionally matching EIP-55 checksum case
- **Wallet + First Contract Targets** - Scan either the wallet address or its first `CREATE` deploy address (nonce 0)
- **Keystore Export** - Download encrypted (scrypt + AES-128-CTR) keystore JSON files

## Requirements

- A modern browser (Chrome, Edge, Firefox, Safari)
- WebGPU is used when available; otherwise the search runs on all but one CPU core

## Usage

1. Choose target: wallet address or first contract address.
2. Enter your desired prefix and/or suffix (hex characters: 0-9, a-f).
3. Click Generate and wait for a match.
4. Confirm the result shows the local verification badge.
5. Reveal the private key or download an encrypted keystore.

## Contract target caveat

The contract target is specifically the first `CREATE` deployment address at nonce 0 for the generated deployer wallet. If that wallet sends any other transaction first, the first-contract address changes.

## How it works

Computing a public key from a private key is a 256-bit scalar multiplication,
far too slow to do per address. Instead, each GPU thread owns a *walker*: a
random private key `c` (from `crypto.getRandomValues`) and its point `C = c·G`.
Every dispatch checks the 2M+1 consecutive keys `c-M … c+M` by adding a table of
precomputed points `i·G` to `C`, then advances `c` by 2M+1. The M+1 modular
inversions those affine additions need are batched into one (Montgomery's
trick), and `C+iG` / `C-iG` share each inverse, so an address costs about six
field multiplications plus Keccak-256. The CPU workers run the same algorithm.

The field arithmetic and Keccak are generated as straight-line code
(`src/webgpu/fieldGen.ts`, `keccakGen.ts`) for two targets: WGSL for the shader
and JavaScript for the CPU workers and the test-suite, which checks the
generated code against BigInt and @noble.

Every search starts from fresh random walkers, and only the single matching key
is ever revealed. Recovering it, or any related key, from an address is the
discrete-log problem.

## Security

- All scanning runs locally in your browser. The production Content Security Policy (`connect-src 'none'`, own scripts only) is set both as a `<meta>` tag and, via `vercel.json`, as an HTTP header, which is what also covers the Web Workers. CSP narrows how a compromised script could leak a key but can't block every channel (e.g. top-level navigation), so the offline advice below still applies.
- Disconnect from the internet after the page loads for maximum security.
- Never share your private key.
- The UI re-derives the wallet/target address from the private key before display/export.
- Impossible or contradictory prefix/suffix combinations are blocked before generation starts.
- Starting a new search or closing the tab asks for confirmation if the found key hasn't been revealed, copied or downloaded yet.

## Development

```bash
# Install dependencies
npm install

# Start dev server
npm run dev

# Run tests (Node: generated field/Keccak code, CPU search, keystore, patterns)
npm test

# Run the WebGPU kernel on real hardware (needs Google Chrome)
npm run test:gpu
npm run test:gpu -- --adapter-luid=0,1234   # choose a GPU on Windows (see chrome://gpu)
npm run test:gpu -- --swiftshader           # CPU-emulated WebGPU, no GPU needed

# Regenerate icons + social cards from src/assets/*.svg (needs Google Chrome)
npm run images

# Build for production
npm run build

# Check dependency audit
npm audit
```

## Tech Stack

- TypeScript
- Vite
- WebGPU (WGSL compute shaders)
- Web Workers
- @noble/secp256k1, @noble/hashes, @noble/ciphers for cryptography
- Vitest for the crypto / kernel test suite, Playwright (system Chrome) for the GPU check

## License

MIT
