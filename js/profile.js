// Player profile persisted locally, keyed by Solana wallet pubkey.
const PROFILES_KEY = 'opusdev_profiles_v1';

function readAll() {
  try {
    const raw = localStorage.getItem(PROFILES_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function writeAll(map) {
  try { localStorage.setItem(PROFILES_KEY, JSON.stringify(map)); }
  catch (e) { console.warn('[profile] save failed', e); }
}

export function loadProfile(pubkey) {
  if (!pubkey) return null;
  const p = readAll()[pubkey];
  return p?.nick ? { nick: p.nick, updatedAt: p.updatedAt || 0 } : null;
}

export function saveProfile(pubkey, nick) {
  if (!pubkey || !nick) return;
  const all = readAll();
  all[pubkey] = { nick, updatedAt: Date.now() };
  writeAll(all);
}
