// Verifies a Google "ID token" (the JWT the Sign-in-with-Google button hands
// back to the browser) on the server, so the frontend can never simply *claim*
// an email address.
//
// How: the token is an RS256-signed JWT. We download Google's public signing
// keys (JWKS), pick the key named in the token header, and let jsonwebtoken
// check the signature, expiry, issuer and — importantly — that the token was
// issued for OUR client id (the `aud` claim).
//
// Requires: GOOGLE_CLIENT_ID in the backend environment.
// No extra npm packages: uses jsonwebtoken + axios, already in package.json.

const crypto = require('crypto');
const axios = require('axios');
const jwt = require('jsonwebtoken');

const GOOGLE_CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const VALID_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

let cache = { keys: null, expiresAt: 0 };

// Overridable so automated tests can supply their own key set.
let fetchCerts = async () => {
  const res = await axios.get(GOOGLE_CERTS_URL, { timeout: 8000 });
  const cc = String(res.headers['cache-control'] || '');
  const m = cc.match(/max-age=(\d+)/);
  const maxAgeMs = (m ? parseInt(m[1], 10) : 3600) * 1000;
  return { keys: res.data.keys || [], maxAgeMs };
};

async function getKeys(forceRefresh = false) {
  if (!forceRefresh && cache.keys && Date.now() < cache.expiresAt) return cache.keys;
  const { keys, maxAgeMs } = await fetchCerts();
  cache = { keys, expiresAt: Date.now() + Math.max(maxAgeMs, 60 * 1000) };
  return keys;
}

function isConfigured() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_ID.trim());
}

async function verifyGoogleIdToken(idToken) {
  if (!isConfigured()) {
    const err = new Error('Google sign-in is not configured on the server.');
    err.statusCode = 503;
    throw err;
  }
  if (!idToken || typeof idToken !== 'string') {
    const err = new Error('Missing Google credential.');
    err.statusCode = 400;
    throw err;
  }

  const decoded = jwt.decode(idToken, { complete: true });
  if (!decoded || !decoded.header || !decoded.header.kid) {
    const err = new Error('Invalid Google credential.');
    err.statusCode = 401;
    throw err;
  }

  let keys = await getKeys();
  let jwk = keys.find(k => k.kid === decoded.header.kid);
  if (!jwk) {
    // Google rotates keys; try one forced refresh before giving up.
    keys = await getKeys(true);
    jwk = keys.find(k => k.kid === decoded.header.kid);
  }
  if (!jwk) {
    const err = new Error('Could not verify Google credential.');
    err.statusCode = 401;
    throw err;
  }

  let payload;
  try {
    const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    payload = jwt.verify(idToken, publicKey, {
      algorithms: ['RS256'],
      audience: process.env.GOOGLE_CLIENT_ID.trim(),
      issuer: VALID_ISSUERS
    });
  } catch (e) {
    const err = new Error('Google credential is invalid or expired. Please try again.');
    err.statusCode = 401;
    throw err;
  }

  if (!payload.sub || !payload.email) {
    const err = new Error('Google account did not return an email address.');
    err.statusCode = 401;
    throw err;
  }
  if (payload.email_verified !== true && payload.email_verified !== 'true') {
    const err = new Error('Your Google email address is not verified.');
    err.statusCode = 401;
    throw err;
  }
  return payload;
}

// Test hook only.
function _setCertFetcher(fn) { fetchCerts = fn; cache = { keys: null, expiresAt: 0 }; }

module.exports = { verifyGoogleIdToken, isConfigured, _setCertFetcher };
