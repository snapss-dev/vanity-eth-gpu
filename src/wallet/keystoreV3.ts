import { scryptAsync } from '@noble/hashes/scrypt.js'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { ctr } from '@noble/ciphers/aes.js'
import { bytesToHex } from '../utils/hex'
import { privateKeyToPublicKey64, type PrivKey32 } from './keys'
import { pubkeyToAddressBytes } from './ethAddress'

// scrypt work factor. N=131072 (r=8,p=1) uses ~128 MB and is dramatically more
// resistant to GPU/ASIC cracking of a leaked keystore than the legacy PBKDF2
// c=65536 default. Standard Web3 Secret Storage params — importable by geth,
// MetaMask, MyEtherWallet, ethers, etc.
const SCRYPT_N = 131072
const SCRYPT_R = 8
const SCRYPT_P = 1

export type KeystoreV3 = {
  version: 3
  id: string
  address: string
  crypto: {
    ciphertext: string
    cipherparams: { iv: string }
    cipher: 'aes-128-ctr'
    kdf: 'scrypt'
    kdfparams: {
      dklen: 32
      n: number
      r: number
      p: number
      salt: string
    }
    mac: string
  }
}

function uuidv4(): string {
  return window.crypto.randomUUID()
}

export async function createKeystoreV3(priv: PrivKey32, password: string): Promise<KeystoreV3> {
  const salt = new Uint8Array(32)
  window.crypto.getRandomValues(salt)
  const iv = new Uint8Array(16)
  window.crypto.getRandomValues(iv)

  const dk = await scryptAsync(password, salt, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, dkLen: 32 })
  const key = dk.slice(0, 16)

  const aes = ctr(key, iv)
  const ciphertext = aes.encrypt(priv)

  const macInput = new Uint8Array(16 + ciphertext.length)
  macInput.set(dk.slice(16, 32), 0)
  macInput.set(ciphertext, 16)
  const mac = keccak_256(macInput)

  const pub64 = privateKeyToPublicKey64(priv)
  const addr = pubkeyToAddressBytes(pub64) // 20 bytes

  return {
    version: 3,
    id: uuidv4(),
    address: bytesToHex(addr),
    crypto: {
      ciphertext: bytesToHex(ciphertext),
      cipherparams: { iv: bytesToHex(iv) },
      cipher: 'aes-128-ctr',
      kdf: 'scrypt',
      kdfparams: {
        dklen: 32,
        n: SCRYPT_N,
        r: SCRYPT_R,
        p: SCRYPT_P,
        salt: bytesToHex(salt),
      },
      mac: bytesToHex(mac),
    },
  }
}
