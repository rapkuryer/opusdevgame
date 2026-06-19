// Phantom via the official injected provider (https://docs.phantom.com).
// Auto-reconnect uses onlyIfTrusted — no popup if the user already approved this site.
const PUBKEY_STORAGE = 'opusdev_wallet_pubkey';

export function getPhantomProvider() {
  if (typeof window === 'undefined') return null;
  const p = window.phantom?.solana;
  if (p?.isPhantom) return p;
  if (window.solana?.isPhantom) return window.solana;
  return null;
}

export function getSavedPubkey() {
  try { return localStorage.getItem(PUBKEY_STORAGE) || null; }
  catch { return null; }
}

export function shortAddress(pubkey) {
  if (!pubkey || pubkey.length < 8) return '';
  return `${pubkey.slice(0, 4)}…${pubkey.slice(-4)}`;
}

/** Silent reconnect for returning players (same browser, prior approval). */
export async function trySilentConnect() {
  const provider = getPhantomProvider();
  if (!provider) return null;
  try {
    const res = await provider.connect({ onlyIfTrusted: true });
    const pubkey = res?.publicKey?.toString?.();
    if (!pubkey) return null;
    localStorage.setItem(PUBKEY_STORAGE, pubkey);
    return pubkey;
  } catch {
    return null;
  }
}

/** User-initiated connect — Phantom shows the approval popup. */
export async function connectPhantom() {
  const provider = getPhantomProvider();
  if (!provider) {
    throw new Error('Install Phantom wallet for Chrome, Brave, or Firefox');
  }
  const res = await provider.connect();
  const pubkey = res?.publicKey?.toString?.();
  if (!pubkey) throw new Error('Wallet did not return a public key');
  localStorage.setItem(PUBKEY_STORAGE, pubkey);
  return pubkey;
}

export function watchWalletDisconnect(onDisconnect) {
  const provider = getPhantomProvider();
  if (!provider?.on) return () => {};
  const handler = () => onDisconnect?.();
  provider.on('disconnect', handler);
  return () => provider.removeListener?.('disconnect', handler);
}
