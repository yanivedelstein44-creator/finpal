/* FinPal Family - opening the app with the phone's fingerprint (or face, or its screen lock): WebAuthn with the
   phone's own authenticator. A choice in עוד ← אבטחה, only beside the lock code, which stays the way in whenever
   the fingerprint does not work. Turned on, the phone makes a key for this site and keeps it (in the phone, or in
   its Google password manager); the app keeps only the public half and checks every answer itself: the challenge
   it made, this site, a person verified by the phone, and the signature. Nothing is sent anywhere. Runs in Node too
   (verify), for the tests. */
import { b64u, unb64u, randomBytes } from './crypto.js';

const te = new TextEncoder(), td = new TextDecoder();
const subtle = () => globalThis.crypto.subtle;
const sha256 = async data => new Uint8Array(await subtle().digest('SHA-256', data));
const ES256 = -7, RS256 = -257;
const FLAG_UP = 0x01, FLAG_UV = 0x04;

/** can this phone (in this browser) check a fingerprint, face or screen lock for a site */
export async function available() {
  try {
    const P = globalThis.PublicKeyCredential;
    return !!(P && P.isUserVerifyingPlatformAuthenticatorAvailable && globalThis.navigator && navigator.credentials
      && await P.isUserVerifyingPlatformAuthenticatorAvailable());
  } catch (e) { return false; }
}

const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/** authenticatorData: for this site, a person present and verified by the phone */
async function dataOk(auth, rpId) {
  return auth.length >= 37 && same(auth.subarray(0, 32), await sha256(te.encode(rpId)))
    && (auth[32] & FLAG_UP) !== 0 && (auth[32] & FLAG_UV) !== 0;
}

/** turn it on: the phone asks for the fingerprint and makes a key. Throws when the phone refuses or the person
    cancels; returns what the app keeps: the key's id and its public half. */
export async function enroll({ rpId, name }) {
  const challenge = randomBytes(32);
  const cred = await navigator.credentials.create({
    publicKey: {
      rp: { id: rpId, name: 'FinPal משפחה' },
      user: { id: randomBytes(16), name, displayName: name },
      challenge,
      pubKeyCredParams: [{ type: 'public-key', alg: ES256 }, { type: 'public-key', alg: RS256 }],
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged', requireResidentKey: false },
      attestation: 'none',
      timeout: 60000
    }
  });
  if (!cred || !cred.response) throw new Error('none');
  const r = cred.response;
  const spki = typeof r.getPublicKey === 'function' ? r.getPublicKey() : null;
  const alg = typeof r.getPublicKeyAlgorithm === 'function' ? r.getPublicKeyAlgorithm() : null;
  if (!spki || (alg !== ES256 && alg !== RS256)) throw new Error('unsupported');
  const cd = JSON.parse(td.decode(r.clientDataJSON));
  if (cd.type !== 'webauthn.create' || cd.challenge !== b64u(challenge) || cd.origin !== location.origin) throw new Error('mismatch');
  if (typeof r.getAuthenticatorData === 'function' && !(await dataOk(new Uint8Array(r.getAuthenticatorData()), rpId))) throw new Error('unverified');
  return { id: b64u(new Uint8Array(cred.rawId)), alg, key: b64u(new Uint8Array(spki)), rp: rpId, at: Date.now() };
}

/** an ECDSA signature as WebAuthn gives it (DER) to the form WebCrypto checks (r and s, 32 bytes each) */
export function derToRaw(der) {
  let i = 0;
  const byte = () => { if (i >= der.length) throw new Error('short'); return der[i++]; };
  const len = () => { let l = byte(); if (l & 0x80) { let n = l & 0x7f; l = 0; while (n--) l = (l << 8) | byte(); } return l; };
  if (byte() !== 0x30) throw new Error('not a sequence');
  len();
  const int = () => {
    if (byte() !== 0x02) throw new Error('not an integer');
    const l = len();
    let v = der.subarray(i, i + l);
    if (v.length !== l) throw new Error('short');
    i += l;
    while (v.length > 32 && v[0] === 0) v = v.subarray(1);
    if (v.length > 32) throw new Error('too long');
    const out = new Uint8Array(32);
    out.set(v, 32 - v.length);
    return out;
  };
  const r = int(), s = int(), out = new Uint8Array(64);
  out.set(r); out.set(s, 32);
  return out;
}

/** the phone's answer, checked by the app: everything, or false */
export async function verify(rec, { challenge, origin, rpId }, { clientDataJSON, authenticatorData, signature }) {
  try {
    const cd = JSON.parse(td.decode(clientDataJSON));
    if (cd.type !== 'webauthn.get' || cd.challenge !== b64u(challenge) || cd.origin !== origin || cd.crossOrigin === true) return false;
    if (!(await dataOk(authenticatorData, rpId))) return false;
    const signed = new Uint8Array(authenticatorData.length + 32);
    signed.set(authenticatorData);
    signed.set(await sha256(clientDataJSON), authenticatorData.length);
    if (rec.alg === ES256) {
      const key = await subtle().importKey('spki', unb64u(rec.key), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      return await subtle().verify({ name: 'ECDSA', hash: 'SHA-256' }, key, derToRaw(signature), signed);
    }
    if (rec.alg === RS256) {
      const key = await subtle().importKey('spki', unb64u(rec.key), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
      return await subtle().verify({ name: 'RSASSA-PKCS1-v1_5' }, key, signature, signed);
    }
    return false;
  } catch (e) { return false; }
}

/** open: the phone asks for the fingerprint of the key turned on here. True only when the app checked the answer. */
export async function unlock(rec) {
  if (!rec || !rec.id) return false;
  const challenge = randomBytes(32);
  let a;
  try {
    a = await navigator.credentials.get({
      publicKey: { challenge, rpId: rec.rp, allowCredentials: [{ type: 'public-key', id: unb64u(rec.id) }], userVerification: 'required', timeout: 60000 }
    });
  } catch (e) { return false; }
  if (!a || !a.response || b64u(new Uint8Array(a.rawId)) !== rec.id) return false;
  return verify(rec, { challenge, origin: location.origin, rpId: rec.rp }, {
    clientDataJSON: new Uint8Array(a.response.clientDataJSON),
    authenticatorData: new Uint8Array(a.response.authenticatorData),
    signature: new Uint8Array(a.response.signature)
  });
}

/** turned off: the app forgets the key, and asks the phone's password manager to drop it too (where it can) */
export async function forget(rec) {
  try {
    const P = globalThis.PublicKeyCredential;
    if (rec && rec.id && P && typeof P.signalUnknownCredential === 'function') await P.signalUnknownCredential({ rpId: rec.rp, credentialId: rec.id });
  } catch (e) { /* the phone keeps it; it opens nothing without this app's record */ }
}
