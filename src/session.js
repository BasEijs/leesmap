// Owns "give me a valid Cookie header for De Correspondent".
//
// Two ways to be authenticated, in priority order:
//   1. DC_COOKIE set  -> use it verbatim (manual fallback, old behaviour). We
//      can't refresh a hand-fed cookie, so we never try to re-login in this mode.
//   2. DC_EMAIL + DC_PASSWORD -> log in programmatically, cache the resulting
//      `session` cookie in memory and on the /data volume, and refresh it
//      automatically when it expires.
//
// The login flow (reverse-engineered from the live site — it's a SvelteKit app):
//   GET  /inloggen                         seed cookies (cookies-cleaned, …)
//   POST /inloggen  {username, continue}   server mints a one-time selector +
//                                          verifier pair, handed back in a
//                                          /inloggen/{selector}/{verifier} path
//   POST /inloggen/{selector}/{verifier}?/defaultLogin
//        {username, password, selector, verifierPlain, continue}
//                                          -> Set-Cookie: session=…  (the prize)
//
// SvelteKit checks the Origin header instead of a CSRF token, and the login
// endpoint is bot-aware, so every request below sends a browser-like User-Agent
// and Origin, and we reuse cookies across the three requests like a browser tab.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { env } from './config.js';

const ORIGIN = 'https://decorrespondent.nl';
const LOGIN_URL = `${ORIGIN}/inloggen`;
const SESSION_PATH = join(env.dataDir, 'session.json');

// A realistic desktop-Chrome UA. The login endpoint returned generic failures
// to a plain curl UA, so we present as a browser here specifically for login.
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// In-memory cache of the Cookie header we hand out (e.g. "session=abc123").
let memoryCookie = '';
// De-dupes concurrent logins: if a login is already running, everyone awaits it.
let loginInFlight = null;

// --- tiny cookie jar helpers -------------------------------------------------

// Pull every Set-Cookie off a response into the jar (name -> value), keeping
// only the "name=value" part and dropping attributes (Path, Secure, …).
function absorbCookies(res, jar) {
  // Node 20+: getSetCookie() returns each Set-Cookie header separately.
  const raw = res.headers.getSetCookie?.() || [];
  for (const line of raw) {
    const [pair] = line.split(';');
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (name) jar.set(name, value);
  }
}

function cookieHeader(jar) {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

// Remove anything email-shaped so a server error message can't leak the address
// into logs or the galei-log.
function scrubEmail(s) {
  return String(s).replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>');
}

// --- persistence (mirrors config.js's settings.json approach) ----------------

function persist(cookie) {
  try {
    if (!existsSync(env.dataDir)) mkdirSync(env.dataDir, { recursive: true });
    writeFileSync(SESSION_PATH, JSON.stringify({ cookie, savedAt: Date.now() }, null, 2));
  } catch (err) {
    // Non-fatal: we still have it in memory this run.
    console.warn('[session] could not persist session.json:', err.message);
  }
}

function loadPersisted() {
  try {
    const { cookie } = JSON.parse(readFileSync(SESSION_PATH, 'utf8'));
    return cookie || '';
  } catch {
    return '';
  }
}

function clearPersisted() {
  try {
    if (existsSync(SESSION_PATH)) writeFileSync(SESSION_PATH, JSON.stringify({ cookie: '' }));
  } catch {
    /* ignore */
  }
}

// --- login -------------------------------------------------------------------

// A SvelteKit form action responds with JSON like {"type":"failure",...,"data":
// "[…devalue-encoded…]"}. Dig the human-readable Dutch message out of `data`.
function dcErrorMessage(parsed) {
  try {
    const arr = JSON.parse(parsed.data);
    // The message is the last plain string with whitespace in the devalue array.
    const msg = arr.filter((x) => typeof x === 'string' && /\s/.test(x)).pop();
    return scrubEmail(msg || `status ${parsed.status}`);
  } catch {
    return `status ${parsed?.status ?? '?'}`;
  }
}

// Extract the selector + verifierPlain the email step mints. They surface as a
// /inloggen/{selector}/{verifier} path — either in a redirect `location` or
// somewhere in the response body. We scan the raw text so we're robust to the
// exact SvelteKit result shape.
function parseSelectorVerifier(text) {
  const m = text.match(/\/inloggen\/([^/"\\?\s]+)\/([0-9a-f]{16,})/i);
  if (!m) return null;
  return { selector: m[1], verifierPlain: m[2] };
}

// Shared headers for the two POSTs. `x-sveltekit-action` + Accept: json make
// SvelteKit answer with the action-result JSON we parse.
function actionHeaders(referer, cookie) {
  return {
    'User-Agent': BROWSER_UA,
    Accept: 'application/json',
    'Accept-Language': 'nl-NL,nl;q=0.9,en;q=0.8',
    'Content-Type': 'application/x-www-form-urlencoded',
    Origin: ORIGIN,
    Referer: referer,
    'x-sveltekit-action': 'true',
    Cookie: cookie,
  };
}

async function doLogin() {
  if (!env.email || !env.password) {
    throw new Error(
      'De Correspondent-login niet geconfigureerd: zet DC_EMAIL en DC_PASSWORD ' +
        '(of val terug op DC_COOKIE).'
    );
  }

  console.log('[session] logging in to De Correspondent as %s', scrubEmail(env.email));
  const jar = new Map();

  // 1) Warm up: GET the login page so we hold the same cookies a browser would.
  const warm = await fetch(LOGIN_URL, {
    headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'nl-NL,nl;q=0.9,en;q=0.8' },
  });
  absorbCookies(warm, jar);

  // 2) Email step: hand over the username, receive the selector/verifier token.
  const emailRes = await fetch(LOGIN_URL, {
    method: 'POST',
    redirect: 'manual', // we want to read the body, not chase a redirect
    headers: actionHeaders(LOGIN_URL, cookieHeader(jar)),
    body: new URLSearchParams({ username: env.email, continue: '' }),
  });
  absorbCookies(emailRes, jar);
  const emailText = await emailRes.text();

  const emailParsed = safeJson(emailText);
  if (emailParsed?.type === 'failure') {
    // e.g. "Sorry, dat e-mailadres is niet bij ons bekend."
    throw new Error(`Inloggen (e-mailstap) mislukt: ${dcErrorMessage(emailParsed)}`);
  }
  // The token can arrive in the JSON body (action redirect) or, if it's a real
  // 3xx, in the Location header — scan both.
  const token = parseSelectorVerifier(`${emailText} ${emailRes.headers.get('location') || ''}`);
  if (!token) {
    // Login form changed, or we got a 2FA / block page instead of the token.
    throw new Error(
      'Inloggen (e-mailstap) gaf geen selector/verifier terug — het loginformulier ' +
        'is mogelijk veranderd, of De Correspondent vraagt om een extra stap (2FA/blokkade).'
    );
  }
  const { selector, verifierPlain } = token;

  // 3) Password step: post credentials + the token back; success sets `session`.
  const stepUrl = `${LOGIN_URL}/${selector}/${verifierPlain}`;
  const pwRes = await fetch(`${stepUrl}?/defaultLogin`, {
    method: 'POST',
    redirect: 'manual',
    headers: actionHeaders(stepUrl, cookieHeader(jar)),
    body: new URLSearchParams({
      username: env.email,
      password: env.password,
      selector,
      verifierPlain,
      continue: '',
    }),
  });
  absorbCookies(pwRes, jar);

  const pwParsed = safeJson(await pwRes.text());
  if (pwParsed?.type === 'failure') {
    // e.g. wrong password. Surface the server's own message (email-scrubbed).
    throw new Error(`Inloggen (wachtwoordstap) mislukt: ${dcErrorMessage(pwParsed)}`);
  }

  const session = jar.get('session');
  if (!session) {
    throw new Error(
      'Inloggen leverde geen session-cookie op — wachtwoord onjuist, of er is ' +
        'een extra stap (2FA) verschenen.'
    );
  }

  memoryCookie = `session=${session}`;
  persist(memoryCookie);
  console.log('[session] login OK, session cookie cached');
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Serialise logins so a burst of requests triggers exactly one.
function login() {
  if (!loginInFlight) loginInFlight = doLogin().finally(() => (loginInFlight = null));
  return loginInFlight;
}

// --- public API --------------------------------------------------------------

// Returns a Cookie header string, logging in on first use if needed.
export async function getCookieHeader() {
  if (env.cookie) return env.cookie; // manual fallback — take it as-is
  if (memoryCookie) return memoryCookie;
  const persisted = loadPersisted();
  if (persisted) {
    memoryCookie = persisted;
    return memoryCookie;
  }
  await login();
  return memoryCookie;
}

// True once the session is known-bad: forget it everywhere and log in again.
async function reauthenticate() {
  memoryCookie = '';
  clearPersisted();
  await login();
}

// Did this response indicate our session is no longer valid?
// De Correspondent expires sessions in two shapes:
//   - 401/403 outright, or
//   - a 302 to /inloggen that fetch silently follows (so we land there at 200).
function isAuthFailure(res) {
  if (res.status === 401 || res.status === 403) return true;
  try {
    if (new URL(res.url).pathname.startsWith('/inloggen')) return true;
  } catch {
    /* no res.url — ignore */
  }
  return false;
}

// fetch() that carries the session cookie and, if the session has expired,
// re-authenticates once and retries the request exactly once. Callers pass their
// own headers (User-Agent, Accept, Referer); we only inject Cookie.
export async function fetchWithSession(url, opts = {}) {
  const run = async () => {
    const cookie = await getCookieHeader();
    return fetch(url, { redirect: 'follow', ...opts, headers: { ...opts.headers, Cookie: cookie } });
  };

  let res = await run();

  // A hand-fed DC_COOKIE can't be refreshed, so don't try — just return it.
  if (env.cookie) return res;

  if (isAuthFailure(res)) {
    console.log('[session] session invalid (HTTP %s / redirected to login) — re-authenticating', res.status);
    await reauthenticate();
    res = await run(); // single retry; no loop even if this also fails
  }
  return res;
}
