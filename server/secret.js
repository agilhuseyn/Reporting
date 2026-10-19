import crypto from 'node:crypto';

// Bağlantı parolları bazada AES-256-GCM ilə şifrələnmiş saxlanır.
// Açar: CONN_SECRET (varsa), yoxsa JWT_SECRET. Açar dəyişərsə, parolları yenidən daxil etmək lazımdır.
function key() {
  const base = process.env.CONN_SECRET || process.env.JWT_SECRET;
  if (!base) throw new Error('CONN_SECRET və ya JWT_SECRET təyin olunmayıb');
  return crypto.scryptSync(base, 'hesabat-portali-conn', 32);
}

export function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}

export function decrypt(blob) {
  if (!blob) return '';
  const [iv, tag, enc] = blob.split('.').map((s) => Buffer.from(s, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}
