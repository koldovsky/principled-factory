// Holdout sets (principle 4.2): written from the intent, stored outside every workspace, optionally encrypted at rest
// with a key that exists only in the factory process's environment, retired once their contents leak.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { FactoryError, nowIso, readJson, sha256, writeJsonAtomic } from './util.mjs';

const SALT_BYTES = 16;

function keyFrom(secret, salt) {
  if (!secret || secret.length < 16) throw new FactoryError('HOLDOUT_KEY', 'holdout key missing or shorter than 16 characters');
  return crypto.scryptSync(secret, salt, 32);
}

export function sealSet(plain, secret) {
  const salt = crypto.randomBytes(SALT_BYTES);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFrom(secret, salt), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(plain), 'utf8'), cipher.final()]);
  return { v: 1, alg: 'aes-256-gcm', kdf: 'scrypt', salt: salt.toString('base64'), iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}

export function openSealed(sealed, secret) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyFrom(secret, Buffer.from(sealed.salt, 'base64')), Buffer.from(sealed.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
  try {
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()]).toString('utf8'));
  } catch {
    throw new FactoryError('HOLDOUT_KEY', 'cannot decrypt holdout set: wrong key or tampered file');
  }
}

export function holdoutDir(controlDir) {
  return path.join(controlDir, 'holdouts');
}

export function listSets(controlDir) {
  const dir = holdoutDir(controlDir);
  if (!fs.existsSync(dir)) return [];
  const ids = fs.readdirSync(dir).map((f) => f.replace(/\.json(\.enc)?$/, '')).filter((x) => x && !x.startsWith('.'));
  return [...new Set(ids)].sort();
}

export function setFiles(controlDir, id) {
  const base = path.join(holdoutDir(controlDir), `${id}.json`);
  return { plain: base, sealed: `${base}.enc` };
}

// Load a set for evaluation. Plaintext is refused when the factory requires sealed holdouts.
export function loadSet(controlDir, id, { requireSealed = false, keyEnv = 'FACTORY_HOLDOUT_KEY' } = {}) {
  const { plain, sealed } = setFiles(controlDir, id);
  if (fs.existsSync(sealed)) {
    const raw = fs.readFileSync(sealed);
    return { set: openSealed(JSON.parse(raw), process.env[keyEnv]), digest: sha256(raw), sealed: true };
  }
  if (fs.existsSync(plain)) {
    if (requireSealed) throw new FactoryError('HOLDOUT_PLAINTEXT', `holdout set ${id} is stored in plaintext; seal it (factory holdouts seal ${id})`);
    const raw = fs.readFileSync(plain);
    return { set: JSON.parse(raw), digest: sha256(raw), sealed: false };
  }
  throw new FactoryError('NO_HOLDOUT', `holdout set ${id} not found`);
}

export function sealFile(controlDir, id, { keyEnv = 'FACTORY_HOLDOUT_KEY', removePlain = true } = {}) {
  const { plain, sealed } = setFiles(controlDir, id);
  const set = readJson(plain);
  fs.writeFileSync(sealed, JSON.stringify(sealSet(set, process.env[keyEnv])) + '\n');
  if (removePlain) fs.rmSync(plain);
  return sealed;
}

// Status per set: active, or retired after its contents reached a builder.
export function setStatus(store, id) {
  return readJson(store.holdouts, {})[id] ?? { status: 'active', exposures: 0 };
}

export function retireSet(store, id, reason, by = 'factory') {
  const all = readJson(store.holdouts, {});
  all[id] = { ...(all[id] ?? {}), status: 'retired', reason, by, at: nowIso() };
  writeJsonAtomic(store.holdouts, all);
  return all[id];
}

// Holdout inputs found verbatim in the candidate's changed files mean the set has leaked into the builder's view.
export function findLeaks(set, changedContents) {
  const leaks = [];
  for (const s of set.scenarios ?? []) {
    const needle = typeof s.input === 'string' ? s.input : null;
    if (!needle || needle.trim().length < 6) continue;
    for (const [file, text] of Object.entries(changedContents)) {
      if (text.includes(needle)) leaks.push({ scenario: s.id, file });
    }
  }
  return leaks;
}
