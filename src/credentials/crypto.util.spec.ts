import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decodeCredentialKey, decrypt, encrypt } from './crypto.util';

describe('encrypt / decrypt', () => {
  const key = randomBytes(32);

  it('round-trips a plaintext token', () => {
    const payload = encrypt('ghp_abcdefghijklmnopqrstuvwxyz0123456789', key);
    expect(decrypt(payload, key)).toBe(
      'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    );
  });

  it('uses a fresh random IV every call, even for identical plaintext', () => {
    const a = encrypt('same-token', key);
    const b = encrypt('same-token', key);
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it('throws on decrypt if the ciphertext was tampered with', () => {
    const payload = encrypt('a-real-token', key);
    payload.ciphertext[0] = payload.ciphertext[0]! ^ 0xff;
    expect(() => decrypt(payload, key)).toThrow();
  });

  it('throws on decrypt if the auth tag was tampered with', () => {
    const payload = encrypt('a-real-token', key);
    payload.authTag[0] = payload.authTag[0]! ^ 0xff;
    expect(() => decrypt(payload, key)).toThrow();
  });

  it('throws on decrypt with the wrong key', () => {
    const payload = encrypt('a-real-token', key);
    expect(() => decrypt(payload, randomBytes(32))).toThrow();
  });
});

describe('decodeCredentialKey', () => {
  it('accepts a valid 32-byte base64 key', () => {
    const encoded = randomBytes(32).toString('base64');
    expect(decodeCredentialKey(encoded)).toHaveLength(32);
  });

  it('rejects a key of the wrong length', () => {
    const encoded = randomBytes(16).toString('base64');
    expect(() => decodeCredentialKey(encoded)).toThrow(/32 bytes/);
  });

  it('rejects an empty key', () => {
    expect(() => decodeCredentialKey('')).toThrow(/32 bytes/);
  });
});
