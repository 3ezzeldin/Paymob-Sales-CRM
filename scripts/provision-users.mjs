#!/usr/bin/env node
/**
 * Provision Paymob Sales CRM users in Supabase.
 *
 *   1. creates an auth user per person (email + password, email pre-confirmed)
 *   2. upserts the matching public.profiles row, keyed on the auth user id
 *   3. links each agent's manager column to their team lead's profile id
 *
 * Managers are created first so their ids exist before the agents reference them.
 * Re-running is safe: existing auth users are reused rather than duplicated, and
 * the profiles upsert merges on id.
 *
 * Usage:
 *   export SUPABASE_URL=https://<project-ref>.supabase.co
 *   export SUPABASE_SERVICE_ROLE_KEY=<service role key>
 *
 *   node scripts/provision-users.mjs                        # dry run, writes nothing
 *   node scripts/provision-users.mjs --apply                # create everything
 *   node scripts/provision-users.mjs --apply --passwords creds.csv
 *   node scripts/provision-users.mjs --apply --agents-only
 *
 * Without --passwords a fresh password is generated per user and the whole set is
 * written to credentials.local.csv (gitignored). With --passwords the given CSV is
 * used instead, so passwords already handed out stay valid. The CSV needs an email
 * column and a password column; other columns are ignored.
 *
 * Node 18+ (uses global fetch). No npm install required.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ok, warn, fail, note, die, colour, env, makeApi,
  discoverColumns, listAuthUsers, makePassword, COLUMN_CANDIDATES,
} from './lib/supabase.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

// ---------------------------------------------------------------- arguments
const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag) => {
  const i = argv.indexOf(flag);
  return i === -1 ? null : argv[i + 1];
};

const APPLY = has('--apply');
const AGENTS_ONLY = has('--agents-only');
const PASSWORD_FILE = valueOf('--passwords');
const ROSTER_FILE = valueOf('--roster') ?? resolve(HERE, 'users.json');

// ---------------------------------------------------------------- utilities
function readPasswordCsv(path) {
  const lines = readFileSync(path, 'utf8').split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) die(`${path} is empty`);
  const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const emailCol = header.findIndex((h) => h.includes('email') || h.includes('user'));
  const pwCol = header.findIndex((h) => h.includes('password'));
  if (emailCol === -1 || pwCol === -1) {
    die(`${path} needs an email column and a password column; found: ${header.join(', ')}`);
  }
  const map = new Map();
  for (const line of lines.slice(1)) {
    const cells = line.split(',');
    const email = (cells[emailCol] ?? '').trim().toLowerCase();
    const password = (cells[pwCol] ?? '').trim();
    if (email && password) map.set(email, password);
  }
  return map;
}

// ---------------------------------------------------------------- supabase
const api = makeApi(env());

async function createAuthUser(person) {
  const { ok: fine, status, payload } = await api('/auth/v1/admin/users', {
    method: 'POST',
    body: {
      email: person.email,
      password: person.password,
      email_confirm: true,
      user_metadata: {
        full_name: person.name,
        title: person.title ?? null,
        role: person.role,
        // Supabase has no built-in forced-reset flag. The app should read this
        // and route to a change-password screen before anything else.
        must_change_password: true,
      },
    },
  });
  if (!fine) throw new Error(`HTTP ${status}: ${JSON.stringify(payload)}`);
  return payload;
}

async function upsertProfiles(rows) {
  const { ok: fine, status, payload } = await api('/rest/v1/profiles?on_conflict=id', {
    method: 'POST',
    body: rows,
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
  });
  if (!fine) throw new Error(`HTTP ${status}: ${JSON.stringify(payload)}`);
  return payload;
}

// ---------------------------------------------------------------- roster
function loadRoster() {
  const raw = JSON.parse(readFileSync(ROSTER_FILE, 'utf8'));
  const d = raw.defaults ?? {};

  const todo = (v) => typeof v === 'string' && v.trim().toUpperCase().startsWith('TODO');

  const seniors = (raw.seniors ?? []).map((p) => ({
    ...p,
    email: String(p.email).trim().toLowerCase(),
    role: p.role ?? 'Admin',
    kind: 'senior',
    existing: p.existing !== false,
  }));
  const managers = (raw.managers ?? []).map((m) => ({
    ...m,
    email: m.email.trim().toLowerCase(),
    role: m.role ?? d.managerRole ?? 'Area Manager',
    kind: 'manager',
  }));
  const agents = (raw.agents ?? []).map((a) => ({
    ...a,
    email: a.email.trim().toLowerCase(),
    role: a.role ?? d.agentRole ?? 'Agent',
    kind: 'agent',
  }));

  const unfilled = [...seniors, ...managers].filter(
    (p) => todo(p.name) || todo(p.email) || todo(p.reportsTo),
  );
  if (unfilled.length) {
    die(`${unfilled.length} roster entr(ies) still contain TODO placeholders.\n` +
        unfilled.map((p) => `  ${p.kind}: ${p.name}`).join('\n') +
        '\nFill in the senior names and emails in ' + ROSTER_FILE + ' before running.');
  }

  // The CRM requires every Area Manager to report to a senior, so an unset or
  // unknown reportsTo is a hard error rather than a null link.
  const seniorNames = new Set(seniors.map((p) => p.name));
  for (const m of managers) {
    if (!m.reportsTo) die(`manager ${m.name} has no reportsTo; an Area Manager must report to a senior`);
    if (!seniorNames.has(m.reportsTo)) {
      die(`manager ${m.name} reports to "${m.reportsTo}", who is not in the seniors list`);
    }
  }
  const managerNames = new Set(managers.map((m) => m.name));
  for (const a of agents) {
    if (a.manager && !managerNames.has(a.manager)) {
      die(`agent ${a.name} names manager "${a.manager}", who is not in the managers list`);
    }
  }
  const seen = new Set();
  for (const p of [...seniors, ...managers, ...agents]) {
    if (seen.has(p.email)) die(`duplicate email in the roster: ${p.email}`);
    seen.add(p.email);
  }

  // An agent with no team of their own sits on their lead's team, which is what
  // the dashboard Team filter (schema-v4.sql) reads.
  const teamByManager = new Map(managers.map((m) => [m.name, m.team]));
  for (const a of agents) {
    if (!a.team && a.manager) a.team = teamByManager.get(a.manager) ?? null;
  }
  return { seniors, managers, agents };
}

// ---------------------------------------------------------------- main
async function main() {
  const { seniors, managers, agents } = loadRoster();
  const people = AGENTS_ONLY ? agents : [...seniors, ...managers, ...agents];

  const supplied = PASSWORD_FILE ? readPasswordCsv(resolve(process.cwd(), PASSWORD_FILE)) : null;
  for (const p of people) {
    p.password = supplied?.get(p.email) ?? makePassword();
    p.passwordSource = supplied?.has(p.email) ? 'supplied' : 'generated';
  }

  const unverified = people.filter((p) => p.emailVerified === false);
  if (unverified.length) {
    warn(`${unverified.length} address(es) were derived from the first.last@${'paymob.com'} pattern, not confirmed:`);
    for (const p of unverified) note(`${p.name} -> ${p.email}`);
    note('Correct them in scripts/users.json if any are wrong. A wrong address creates an account nobody can sign in to.');
    console.log('');
  }

  console.log(`Supabase project : ${env().url}`);
  console.log(`Roster           : ${seniors.length} senior(s), ${managers.length} manager(s), ${agents.length} agent(s)`);
  console.log(`Mode             : ${APPLY ? 'APPLY (writes to the project)' : 'DRY RUN (writes nothing)'}`);
  console.log('');

  const { resolved, present } = await discoverColumns(api);
  if (!present.has('id')) die('the profiles table has no id column; this script keys profiles on the auth user id.');
  console.log('profiles columns in use:');
  for (const [role, col] of Object.entries(resolved)) note(`${role.padEnd(8)} -> ${col}`);
  for (const role of Object.keys(COLUMN_CANDIDATES)) {
    if (!resolved[role]) warn(`no column found for "${role}"; that value will not be written`);
  }
  if (!resolved.manager) {
    warn('without a manager column the reporting hierarchy cannot be set, and in_my_scope() will not');
    note('match anyone. Check the column name in schema-hierarchy.sql and add it to COLUMN_CANDIDATES.');
  }
  console.log('');

  if (!APPLY) {
    console.log('Would create:');
    for (const p of people) {
      const up = p.reportsTo ?? p.manager ?? '-';
      const tag = p.existing ? '(existing, lookup only)' : '';
      console.log(`  ${p.kind.padEnd(7)} ${p.email.padEnd(30)} role=${String(p.role).padEnd(14)} reports to=${String(up).padEnd(18)} ${tag}`);
    }
    console.log(`\n${colour.YELLOW}Dry run only. Re-run with --apply to create these accounts.${colour.OFF}`);
    return;
  }

  const existing = await listAuthUsers(api);
  const idByName = new Map();
  const results = [];

  for (const group of AGENTS_ONLY ? [agents] : [seniors, managers, agents]) {
    for (const p of group) {
      const already = existing.get(p.email);
      if (p.existing && !already) {
        fail(`${p.email} is marked "existing": true but no account with that address was found.`);
        note('Check the address, or set "existing": false to have it created.');
        p.status = 'failed';
        continue;
      }
      if (p.existing) {
        ok(`found existing account ${p.email} (${p.role})`);
        p.id = already.id;
        p.status = 'existing';
        idByName.set(p.name, p.id);
        results.push(p);
        continue;
      }
      if (already) {
        warn(`${p.email} already has an auth user; reusing it and leaving the password unchanged`);
        p.id = already.id;
        p.status = 'existing';
      } else {
        try {
          const user = await createAuthUser(p);
          p.id = user.id;
          p.status = 'created';
          ok(`auth user ${p.email}`);
        } catch (err) {
          fail(`auth user ${p.email}: ${err.message}`);
          p.status = 'failed';
          continue;
        }
      }
      idByName.set(p.name, p.id);
      results.push(p);
    }
  }

  // A senior's existing profile is left alone; only their id is used for links.
  const rows = results.filter((p) => !p.existing).map((p) => {
    const row = { id: p.id };
    if (resolved.name) row[resolved.name] = p.name;
    if (resolved.email) row[resolved.email] = p.email;
    if (resolved.role) row[resolved.role] = p.role;
    if (resolved.title && p.title) row[resolved.title] = p.title;
    if (resolved.team && p.team) row[resolved.team] = p.team;
    const upline = p.reportsTo ?? p.manager ?? null;
    if (resolved.manager) row[resolved.manager] = upline ? (idByName.get(upline) ?? null) : null;
    return row;
  });

  if (rows.length) {
    try {
      await upsertProfiles(rows);
      ok(`upserted ${rows.length} profiles row(s)`);
    } catch (err) {
      fail(`profiles upsert: ${err.message}`);
      note('The auth users exist. Fix the error and re-run; the upsert merges on id.');
    }
  }

  const fresh = results.filter((p) => p.status === 'created' && p.passwordSource === 'generated');
  if (fresh.length) {
    const out = resolve(ROOT, 'credentials.local.csv');
    const csv = ['name,email,role,team,manager,password']
      .concat(fresh.map((p) => [p.name, p.email, p.role, p.team ?? '', p.manager ?? '', p.password].join(',')))
      .join('\n');
    writeFileSync(out, csv + '\n', { mode: 0o600 });
    console.log('');
    ok(`passwords for ${fresh.length} new account(s) written to ${out}`);
    note('This file is gitignored. Distribute each password to its owner, then delete it.');
  }

  const created = results.filter((p) => p.status === 'created').length;
  const reused = results.filter((p) => p.status === 'existing').length;
  const failed = people.length - results.length;
  console.log(`\nDone: ${created} created, ${reused} already existed, ${failed} failed.`);
  if (failed) process.exitCode = 1;
}

main().catch((err) => die(err.stack ?? String(err)));
