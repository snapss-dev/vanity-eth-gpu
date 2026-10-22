import * as secp from '@noble/secp256k1'

export type PrivKey32 = Uint8Array & { readonly __priv32: unique symbol }

export function privateKeyToPublicKey64(priv: PrivKey32): Uint8Array {
  const pub65 = secp.getPublicKey(priv, false) // 65 bytes, 0x04 + x(32) + y(32)
  return pub65.slice(1) // 64 bytes (x||y)
}
