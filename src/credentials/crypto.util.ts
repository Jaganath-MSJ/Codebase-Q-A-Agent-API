import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // 96-bit, the GCM-recommended IV length
const KEY_BYTES = 32; // 256-bit

export interface EncryptedPayload {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
}

export function decodeCredentialKey(base64Key: string): Buffer {
  const key = Buffer.from(base64Key, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `CREDENTIAL_KEY must decode to exactly ${KEY_BYTES} bytes (got ${key.length}) — ` +
        `generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
    );
  }
  return key;
}

/** A fresh random IV per call — reusing an IV with GCM leaks the key stream, not just weakens it. */
export function encrypt(plaintext: string, key: Buffer): EncryptedPayload {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag() };
}

/** Throws if the auth tag doesn't verify — GCM without that check is unauthenticated encryption. */
export function decrypt(payload: EncryptedPayload, key: Buffer): string {
  const decipher = createDecipheriv(ALGORITHM, key, payload.iv);
  decipher.setAuthTag(payload.authTag);
  return Buffer.concat([decipher.update(payload.ciphertext), decipher.final()]).toString('utf8');
}
