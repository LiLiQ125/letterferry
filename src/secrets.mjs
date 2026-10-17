import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export function loadEncryptionKey(env = process.env) {
  const raw = env.RIVEN_WEIXIN_CONTEXT_KEY || '';
  if (!/^[a-f0-9]{64}$/i.test(raw)) throw new Error('RIVEN_WEIXIN_CONTEXT_KEY_REQUIRED_64_HEX');
  return Buffer.from(raw, 'hex');
}

export function seal(plaintext, key) {
  if (typeof plaintext !== 'string' || !plaintext) throw new Error('CONTEXT_TOKEN_REQUIRED');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ciphertext.toString('base64url')}`;
}

export function unseal(value, key) {
  const [version, iv, tag, ciphertext, extra] = String(value).split('.');
  if (version !== 'v1' || !iv || !tag || !ciphertext || extra) throw new Error('INVALID_SEALED_VALUE');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
}
