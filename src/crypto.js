import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';

export function loadOrCreateMasterKey(file) {
  if (fs.existsSync(file)) {
    const key = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64url');
    if (key.length !== 32) throw new Error('master.key 内容无效');
    return key;
  }
  const key = randomBytes(32);
  fs.writeFileSync(file, key.toString('base64url'), { mode: 0o600, flag: 'wx' });
  return key;
}

export function encrypt(value, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}

export function decrypt(value, key) {
  const input = Buffer.from(value, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', key, input.subarray(0, 12));
  decipher.setAuthTag(input.subarray(12, 28));
  return Buffer.concat([decipher.update(input.subarray(28)), decipher.final()]).toString('utf8');
}

export const sha256 = (value) => createHash('sha256').update(value).digest('hex');
export const hmac256 = (key, value) => createHmac('sha256', key).update(value).digest('hex');

export function safeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export const randomToken = (prefix = '') => prefix + randomBytes(24).toString('base64url');
