/**
 * Shared Supabase helpers for the provisioning and lifecycle scripts.
 * Node 18+ (global fetch). No npm install required.
 */
import { randomInt } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const GREEN = '\x1b[32m', RED = '\x1b[31m', YELLOW = '\x1b[33m', DIM = '\x1b[2m', OFF = '\x1b[0m';
export const ok = (m) => console.log(`${GREEN}  ok${OFF} ${m}`);
export const warn = (m) => console.log(`${YELLOW}warn${OFF} ${m}`);
export const fail = (m) => console.log(`${RED}fail${OFF} ${m}`);
export const note = (m) => console.log(`${DIM}      ${m}${OFF}`);
export const colour = { GREEN, RED, YELLOW, DIM, OFF };

export function die(message) {
  console.error(`\n${RED}${message}${OFF}\n`);
  process.exit(1);
}

/**
 * Reads .env from the project root if it is there, so the credentials can live
 * in a gitignored file rather than being exported into a shell every time.
 * Anything already set in the real environment wins.
 */
function loadDotEnv() {
  const file = resolve(dirname(fileURLToPath(import.meta.url)), '../..', '.env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/i);
    if (!m) continue;
    const key = m[1];
    const value = m[2].trim().replace(/^(['"])(.*)\1$/s, '$2');
    if (!(key in process.env)) process.env[key] = value;
  }
}

export function env() {
  loadDotEnv();
  const url = (process.env.SUPABASE_URL ?? '').replace(/\/+$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!url || !key) {
    die('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY before running.\n\n' +
        'Either export them, or put them in a .env file in the project root\n' +
        '(it is gitignored):\n\n' +
        '  SUPABASE_URL=https://<project-ref>.supabase.co\n' +
        '  SUPABASE_SERVICE_ROLE_KEY=<service role key>');
  }
  return { url, key };
}

export function makeApi({ url, key }) {
  return async function api(path, { method = 'GET', body, headers = {} } = {}) {
    const res = await fetch(`${url}${path}`, {
      method,
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let payload = null;
    if (text) {
      try { payload = JSON.parse(text); } catch { payload = text; }
    }
    return { ok: res.ok, status: res.status, payload };
  };
}

/**
 * The hierarchy migration (schema-hierarchy.sql) was never available here, so
 * column names are discovered from the PostgREST schema rather than assumed.
 */
export const COLUMN_CANDIDATES = {
  name: ['full_name', 'name', 'display_name', 'agent_name'],
  username: ['username', 'user_name', 'login'],
  email: ['email'],
  role: ['role', 'user_role'],
  manager: ['manager_id', 'parent_id', 'reports_to', 'supervisor_id', 'manager'],
  team: ['team'],
  title: ['title', 'job_title', 'position'],
  active: ['is_active', 'active', 'status', 'enabled'],
};

export async function discoverColumns(api, table = 'profiles', candidates = COLUMN_CANDIDATES) {
  const { ok: fine, status, payload } = await api('/rest/v1/');
  if (!fine) die(`could not read the PostgREST schema (HTTP ${status}). Check SUPABASE_URL and the service role key.`);
  const defs = payload?.definitions ?? payload?.components?.schemas ?? {};
  const def = defs[table];
  if (!def) die(`no "${table}" table is exposed by PostgREST. Run the SQL migrations first.`);
  const present = new Set(Object.keys(def.properties ?? {}));
  const resolved = {};
  for (const [role, names] of Object.entries(candidates)) {
    const hit = names.find((c) => present.has(c));
    if (hit) resolved[role] = hit;
  }
  return { resolved, present };
}

export async function listAuthUsers(api) {
  const byEmail = new Map();
  for (let page = 1; page <= 50; page++) {
    const { ok: fine, status, payload } = await api(`/auth/v1/admin/users?page=${page}&per_page=200`);
    if (!fine) die(`could not list auth users (HTTP ${status}): ${JSON.stringify(payload)}`);
    const users = payload?.users ?? [];
    for (const u of users) if (u.email) byEmail.set(u.email.toLowerCase(), u);
    if (users.length < 200) break;
  }
  return byEmail;
}

// Alphabet excludes look-alikes (0/O, 1/l/I, 5/S, 2/Z) and the comma, so a
// password survives being read aloud and being stored in a CSV.
const UPPER = 'ABCDEFGHJKLMNPQRTUVWXY';
const LOWER = 'abcdefghijkmnpqrtuvwxy';
const DIGIT = '34679';
const SYMBOL = '!@#$%*?+=';
const ALL = UPPER + LOWER + DIGIT + SYMBOL;
const pick = (set) => set[randomInt(set.length)];

export function makePassword(length = 14) {
  for (;;) {
    const chars = [pick(UPPER), pick(UPPER), pick(LOWER), pick(LOWER),
                   pick(DIGIT), pick(DIGIT), pick(SYMBOL), pick(SYMBOL)];
    while (chars.length < length) chars.push(pick(ALL));
    for (let i = chars.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [chars[i], chars[j]] = [chars[j], chars[i]];
    }
    const pw = chars.join('');
    if (!/(.)\1\1/.test(pw)) return pw;
  }
}
