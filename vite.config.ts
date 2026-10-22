import { defineConfig, type Plugin } from 'vite'
import { generateField } from './src/webgpu/fieldGen'
import { generateKeccak } from './src/webgpu/keccakGen'

// The CPU workers run the same generated field arithmetic and Keccak as the GPU
// kernel, emitted as plain JavaScript at build time (no eval at run time).
function cpuKernel(): Plugin {
  const id = 'virtual:cpu-kernel'
  return {
    name: 'cpu-kernel',
    resolveId(source) {
      return source === id ? '\0' + id : null
    },
    load(resolved) {
      if (resolved !== '\0' + id) return null
      return [
        generateField('js', { mulRows: 1 }),
        generateKeccak('js'),
        'export { fe_add, fe_sub, fe_mul, fe_sqr, fe_inv, keccak256_17, eth_address }',
      ].join('\n\n')
    },
  }
}

// The page generates private keys, so production forbids network connections
// (fetch/XHR/WebSocket: connect-src 'none') and any script, style or worker
// that isn't one of our own files. The <meta> tag covers the page wherever it's
// hosted; workers only get a policy from HTTP headers, so vercel.json sends the
// same policy as a header (test/csp.test.ts keeps the two in sync). CSP can't
// stop top-level navigation, so this narrows exfiltration paths rather than
// closing every one. Dev builds skip it (Vite's HMR needs inline scripts and a socket).
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "worker-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "manifest-src 'self'",
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
].join('; ')

// frame-ancestors only works as a header, not in <meta>.
export const CONTENT_SECURITY_POLICY_HEADER = CONTENT_SECURITY_POLICY + "; frame-ancestors 'none'"

function contentSecurityPolicy(): Plugin {
  return {
    name: 'content-security-policy',
    apply: 'build',
    transformIndexHtml() {
      return [{
        tag: 'meta',
        attrs: { 'http-equiv': 'Content-Security-Policy', content: CONTENT_SECURITY_POLICY },
        injectTo: 'head-prepend',
      }]
    },
  }
}

export default defineConfig({
  plugins: [cpuKernel(), contentSecurityPolicy()],
  build: {
    target: 'esnext',
  },
  // `vite preview` serves the production build with the same header as Vercel.
  preview: {
    headers: { 'Content-Security-Policy': CONTENT_SECURITY_POLICY_HEADER },
  },
  worker: {
    plugins: () => [cpuKernel()],
    format: 'es',
  },
})
