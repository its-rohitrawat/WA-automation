import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 1;
const IV_LEN = 12;
const TAG_LEN = 16;

function checkKey(key: Buffer): void {
  if (key.length !== 32) throw new Error('Encryption key must be 32 bytes');
}

/** Layout: [version 1 byte][iv 12][auth tag 16][ciphertext]. */
export function encrypt(key: Buffer, plaintext: Buffer): Buffer {
  checkKey(key);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), ciphertext]);
}

export function decrypt(key: Buffer, blob: Buffer): Buffer {
  checkKey(key);
  if (blob[0] !== VERSION) throw new Error('Unsupported ciphertext version');
  const iv = blob.subarray(1, 1 + IV_LEN);
  const tag = blob.subarray(1 + IV_LEN, 1 + IV_LEN + TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(blob.subarray(1 + IV_LEN + TAG_LEN)), decipher.final()]);
}
