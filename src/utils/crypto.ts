/**
 * AES-256-GCM encryption and decryption utility using Web Crypto API.
 * Uses zero Node.js native dependencies, running seamlessly on Cloudflare Workers edge.
 */

/**
 * Converts a hex string into a Uint8Array.
 */
function hexToBytes(hex: string): Uint8Array {
  const cleanHex = hex.trim();
  if (cleanHex.length % 2 !== 0) {
    throw new Error('Invalid hex string length');
  }
  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < cleanHex.length; i += 2) {
    bytes[i / 2] = parseInt(cleanHex.substring(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Converts a Uint8Array into a hex string.
 */
function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * Derives or imports a CryptoKey from a 32-byte secret key (hex string or raw text).
 */
async function getCryptoKey(secretKey: string): Promise<CryptoKey> {
  let rawKey: Uint8Array;
  // If 64 hex characters (32 bytes hex)
  if (/^[0-9a-fA-F]{64}$/.test(secretKey)) {
    rawKey = hexToBytes(secretKey);
  } else {
    // Hash key with SHA-256 to ensure exact 256-bit key length
    const enc = new TextEncoder();
    const digest = await crypto.subtle.digest('SHA-256', enc.encode(secretKey));
    rawKey = new Uint8Array(digest);
  }

  return await crypto.subtle.importKey(
    'raw',
    rawKey,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Encrypts a plaintext string with AES-256-GCM.
 * Output format: `<iv_hex>:<ciphertext_and_tag_hex>`
 */
export async function encryptText(plainText: string, secretKey: string): Promise<string> {
  const key = await getCryptoKey(secretKey);
  const iv = crypto.getRandomValues(new Uint8Array(12)); // 96-bit IV recommended for AES-GCM
  const encodedText = new TextEncoder().encode(plainText);

  const encryptedBuffer = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
    },
    key,
    encodedText
  );

  const ivHex = bytesToHex(iv);
  const cipherHex = bytesToHex(new Uint8Array(encryptedBuffer));
  return `${ivHex}:${cipherHex}`;
}

/**
 * Decrypts a ciphertext string produced by encryptText.
 */
export async function decryptText(encryptedPayload: string, secretKey: string): Promise<string> {
  const parts = encryptedPayload.split(':');
  if (parts.length !== 2) {
    throw new Error('Invalid encrypted payload format. Expected <iv_hex>:<ciphertext_hex>');
  }

  const [ivHex, cipherHex] = parts;
  const iv = hexToBytes(ivHex);
  const cipherBytes = hexToBytes(cipherHex);
  const key = await getCryptoKey(secretKey);

  const decryptedBuffer = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv,
    },
    key,
    cipherBytes
  );

  return new TextDecoder().decode(decryptedBuffer);
}
