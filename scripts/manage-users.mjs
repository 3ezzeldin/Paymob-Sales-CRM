#!/usr/bin/env node
/**
 * Joiners, movers and leavers for the Paymob Sales CRM.
 *
 * Reads scripts/changes.json and applies three kinds of change:
 *
 *   add       create an account (same as provision-users.mjs, for one person)
 *   move      change someone's team and/or who they report to
 *   offboard  hand their book of business to a successor, then disable them
 *
 * Why offboarding reassigns first
 * -------------------------------
 * merchants.owner_agent_id is "references profiles(id) on delete set null", and
 * the RLS policy reads "sees_all() or in_my_scope(owner_agent_id)". Delete a
 * profile and every merchant they owned keeps its row but loses its owner, so
 * in_my_scope() can no longer match it and the record drops out of sight for
 * everyone except an admin or director. The merchants are not deleted; they
 * become invisible, which is worse, because nobody notices.
 *
 * So a leaver is DEACTIVATED by default, not deleted, and their merchants and
 * activities are reassigned first. --delete is available but refuses to run
 * unless a successor is named and the reassignment has succeeded.
 *
 * Usage:
 *   export SUPABASE_URL=https://<project-ref>.supabase.co
 *   export SUPABASE_SERVICE_ROLE_KEY=<service role key>
 *
 *   node scripts/manage-users.mjs                 # dry run, writes nothing
 *   node scripts/manage-users.mjs --apply
 *   node scripts/manage-users.mjs --apply --delete
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ok, warn, fail, note, die, colour, env, makeApi,
  discoverColumns, listAuthUsers, makePassword,
} from './lib/supabase.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valueOf = (f) => { const i = argv.indexOf(f); return i === -1 ? null : argv[i + 1]; };

const APPLY = has('--apply');
const HARD_DELETE = has('--delete');
const CHANGES_FILE = valueOf('--changes') ?? resolve(HERE, 'changes.json');

const api = makeApi(env());

// ------------------------------------------------------------------ lookups
const textFields = (p) => Object.values(p).filter((v) => typeof v === 'string');
const label = (p, resolved) => p[resolved.name] ?? p[resolved.username] ?? p[resolved.email] ?? p.id;

/**
 * Resolves a person by username, full name or email. Falls back to a partial
 * match on one name ("Hassan"), which is how people actually refer to each
 * other, but only when exactly one profile matches — an ambiguous reference
 * stops the run rather than picking somebody at random.
 */
function findProfile(profiles, who, resolved = {}) {
  const needle = String(who).trim().toLowerCase();
  if (!needle) return null;

  const exact = profiles.filter((p) =>
    textFields(p).some((v) => v.trim().toLowerCase() === needle));
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    die(`"${who}" matches ${exact.length} profiles exactly; use the email address instead`);
  }

  const partial = profiles.filter((p) =>
    textFields(p).some((v) => v.toLowerCase().split(/[\s._@-]+/).includes(needle)));
  if (partial.length === 1) {
    warn(`"${who}" matched ${label(partial[0], resolved)} on a partial name`);
    return partial[0];
  }
  if (partial.length > 1) {
    die(`"${who}" is ambiguous — it matches ${partial.length} people:\n` +
        partial.map((p) => `  ${label(p, resolved)}`).join('\n') +
        '\nUse the full name or the email address in the changes file.');
  }
  return null;
}

/**
 * "@manager" means "whoever this person already reports to", so a book of
 * business can be handed up the chain without naming the lead. "@manager" on
 * toTeam means "the team of the manager being moved to".
 */
function resolveManagerOf(profiles, person, resolved) {
  if (!resolved.manager) return null;
  const id = person[resolved.manager];
  return id ? (profiles.find((p) => p.id === id) ?? null) : null;
}

async function loadProfiles() {
  const { ok: fine, status, payload } = await api('/rest/v1/profiles?select=*');
  if (!fine) die(`could not read profiles (HTTP ${status}): ${JSON.stringify(payload)}`);
  return payload ?? [];
}

async function countOwned(table, column, id) {
  const { ok: fine, payload, status } = await api(
    `/rest/v1/${table}?${column}=eq.${id}&select=id`, { headers: { Prefer: 'count=exact' } });
  if (!fine) {
    warn(`could not count ${table} for ${id} (HTTP ${status})`);
    return null;
  }
  return Array.isArray(payload) ? payload.length : null;
}

async function reassign(table, idColumn, nameColumn, fromId, toId, toName) {
  const body = { [idColumn]: toId };
  if (nameColumn && toName) body[nameColumn] = toName;
  const { ok: fine, status, payload } = await api(
    `/rest/v1/${table}?${idColumn}=eq.${fromId}`,
    { method: 'PATCH', body, headers: { Prefer: 'return=representation' } });
  if (!fine) throw new Error(`${table} (HTTP ${status}): ${JSON.stringify(payload)}`);
  return Array.isArray(payload) ? payload.length : 0;
}

// --------------------------------------------------------------------- main
async function main() {
  const changes = JSON.parse(readFileSync(CHANGES_FILE, 'utf8'));

  // A TODO reaching the API would create an account named "TODO" or reassign a
  // book of business to nobody, so it stops the run before anything is touched.
  const todos = [];
  JSON.stringify(changes, (k, v) => {
    if (k !== '_comment' && typeof v === 'string' && v.trim().toUpperCase().startsWith('TODO')) todos.push(v);
    return v;
  });
  if (todos.length) {
    die(`${todos.length} unresolved placeholder(s) in ${CHANGES_FILE}:\n` +
        todos.map((t) => `  ${t}`).join('\n'));
  }

  const adds = changes.add ?? [];
  const moves = changes.move ?? [];
  const leavers = changes.offboard ?? [];

  console.log(`Changes file : ${CHANGES_FILE}`);
  console.log(`Mode         : ${APPLY ? 'APPLY' : 'DRY RUN (writes nothing)'}`);
  if (HARD_DELETE) warn('--delete given: leavers will be removed, not just deactivated');
  console.log('');

  const { resolved } = await discoverColumns(api);
  console.log('profiles columns in use:');
  for (const [k, v] of Object.entries(resolved)) note(`${k.padEnd(9)} -> ${v}`);
  if (!resolved.active && !HARD_DELETE) {
    warn('no active/status column found on profiles, so a leaver cannot be marked inactive.');
    note('Their merchants will still be reassigned, and their account left in place.');
    note('Add a status column, or re-run with --delete once you have read what it does.');
  }
  console.log('');

  const profiles = await loadProfiles();
  const authUsers = await listAuthUsers(api);
  const newPasswords = [];

  // ---------------------------------------------------------------- joiners
  for (const p of adds) {
    const email = String(p.email).trim().toLowerCase();
    const manager = p.reportsTo ? findProfile(profiles, p.reportsTo, resolved) : null;
    if (p.reportsTo && !manager) {
      fail(`add ${p.name}: "${p.reportsTo}" not found in profiles`);
      continue;
    }
    if (authUsers.has(email)) {
      warn(`add ${p.name}: ${email} already has an account; skipping`);
      continue;
    }
    if (!APPLY) {
      console.log(`  add       ${p.name} <${email}> role=${p.role} team=${p.team ?? '-'} reports to=${p.reportsTo ?? '-'}`);
      continue;
    }
    const password = p.password ?? makePassword();
    const { ok: fine, status, payload } = await api('/auth/v1/admin/users', {
      method: 'POST',
      body: {
        email, password, email_confirm: true,
        user_metadata: { full_name: p.name, username: p.username ?? null,
                         title: p.title ?? null, role: p.role, must_change_password: true },
      },
    });
    if (!fine) { fail(`add ${p.name}: HTTP ${status} ${JSON.stringify(payload)}`); continue; }

    const row = { id: payload.id };
    if (resolved.name) row[resolved.name] = p.name;
    if (resolved.username && p.username) row[resolved.username] = p.username;
    if (resolved.email) row[resolved.email] = email;
    if (resolved.role) row[resolved.role] = p.role;
    if (resolved.team && p.team) row[resolved.team] = p.team;
    if (resolved.title && p.title) row[resolved.title] = p.title;
    if (resolved.manager && manager) row[resolved.manager] = manager.id;
    // Without this a new profile can land with a null status and be filtered
    // out of the user list, looking like the account was never created.
    if (resolved.active) row[resolved.active] = resolved.active === 'status' ? 'Active' : true;
    const up = await api('/rest/v1/profiles?on_conflict=id', {
      method: 'POST', body: [row],
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    });
    if (!up.ok) { fail(`add ${p.name}: profile ${up.status} ${JSON.stringify(up.payload)}`); continue; }
    newPasswords.push({ ...p, email, password });
    ok(`added ${p.name} <${email}>`);
  }

  // ----------------------------------------------------------------- movers
  for (const m of moves) {
    const who = findProfile(profiles, m.who ?? m.email ?? m.name, resolved);
    if (!who) { fail(`move: "${m.who ?? m.email ?? m.name}" not found in profiles`); continue; }
    const toManager = m.toManager ? findProfile(profiles, m.toManager, resolved) : null;
    if (m.toManager && !toManager) { fail(`move ${m.who}: new manager "${m.toManager}" not found`); continue; }

    const patch = {};
    const team = m.toTeam === '@manager'
      ? (toManager ? toManager[resolved.team] : null)
      : m.toTeam;
    if (m.toTeam === '@manager' && !toManager) {
      fail(`move ${m.who}: toTeam is "@manager" but no toManager was given`);
      continue;
    }
    if (resolved.team && team) patch[resolved.team] = team;
    if (resolved.manager && toManager) patch[resolved.manager] = toManager.id;
    if (!Object.keys(patch).length) { warn(`move ${m.who}: nothing to change`); continue; }

    if (!APPLY) {
      console.log(`  move      ${m.who} -> team=${team ?? 'unchanged'} manager=${toManager ? label(toManager, resolved) : 'unchanged'}`);
      continue;
    }
    const res = await api(`/rest/v1/profiles?id=eq.${who.id}`, {
      method: 'PATCH', body: patch, headers: { Prefer: 'return=representation' } });
    if (!res.ok) { fail(`move ${m.who}: HTTP ${res.status} ${JSON.stringify(res.payload)}`); continue; }
    ok(`moved ${m.who}${team ? ` to ${team}` : ''}${toManager ? ` under ${label(toManager, resolved)}` : ''}`);
  }

  // ---------------------------------------------------------------- leavers
  for (const l of leavers) {
    const who = findProfile(profiles, l.who ?? l.email ?? l.name, resolved);
    if (!who) { fail(`offboard: "${l.who ?? l.email ?? l.name}" not found in profiles`); continue; }
    const successor = l.reassignTo === '@manager'
      ? resolveManagerOf(profiles, who, resolved)
      : (l.reassignTo ? findProfile(profiles, l.reassignTo, resolved) : null);
    if (l.reassignTo === '@manager' && !successor) {
      fail(`offboard ${l.who}: reassignTo is "@manager" but they have no manager set`);
      note('Name the successor explicitly in changes.json instead.');
      continue;
    }
    if (l.reassignTo && !successor) { fail(`offboard ${l.who}: successor "${l.reassignTo}" not found`); continue; }
    const successorName = successor ? label(successor, resolved) : null;

    const merchants = await countOwned('merchants', 'owner_agent_id', who.id);
    const activities = await countOwned('activities', 'agent_id', who.id);
    console.log(`  offboard  ${l.who}${l.reason ? ` (${l.reason})` : ''}: owns ${merchants ?? '?'} merchant(s), ${activities ?? '?'} activity record(s)`);

    if (!successor && (merchants || activities)) {
      fail(`${l.who} still owns records and no reassignTo was given.`);
      note('Deactivating now would leave those merchants owned by a disabled user;');
      note('deleting would null their owner and hide them from everyone but an admin.');
      note('Add "reassignTo" to this entry in changes.json and re-run.');
      continue;
    }
    if (HARD_DELETE && !successor) {
      fail(`refusing to delete ${l.who} without a successor named in reassignTo`);
      continue;
    }
    if (!APPLY) {
      console.log(`            would reassign to ${successorName ?? '(nothing to reassign)'}, then ${HARD_DELETE ? 'DELETE' : 'deactivate'}`);
      continue;
    }

    if (successor) {
      try {
        const nameCol = resolved.name ? 'owner_agent' : null;
        const m = await reassign('merchants', 'owner_agent_id', nameCol, who.id, successor.id, successor[resolved.name]);
        const a = await reassign('activities', 'agent_id', 'agent', who.id, successor.id, successor[resolved.name]);
        ok(`reassigned ${m} merchant(s) and ${a} activity record(s) to ${successorName}`);
      } catch (err) {
        fail(`offboard ${l.who}: reassignment failed, nothing else was changed: ${err.message}`);
        continue;
      }
    }

    if (HARD_DELETE) {
      const res = await api(`/auth/v1/admin/users/${who.id}`, { method: 'DELETE' });
      if (!res.ok) { fail(`delete ${l.who}: HTTP ${res.status} ${JSON.stringify(res.payload)}`); continue; }
      ok(`deleted ${l.who}`);
    } else if (resolved.active) {
      const col = resolved.active;
      const off = col === 'status' ? (l.statusValue ?? 'Inactive') : false;
      const res = await api(`/rest/v1/profiles?id=eq.${who.id}`, {
        method: 'PATCH', body: { [col]: off }, headers: { Prefer: 'return=representation' } });
      if (!res.ok) { fail(`deactivate ${l.who}: HTTP ${res.status} ${JSON.stringify(res.payload)}`); continue; }
      // Block sign-in as well as hiding them in the UI.
      await api(`/auth/v1/admin/users/${who.id}`, { method: 'PUT', body: { ban_duration: '876000h' } });
      ok(`deactivated ${l.who} (${col} = ${off}) and blocked sign-in`);
    } else {
      warn(`${l.who}: records reassigned, but no active column exists to mark them inactive`);
    }
  }

  if (newPasswords.length) {
    const out = resolve(ROOT, 'credentials.local.csv');
    const csv = ['name,username,email,role,team,password']
      .concat(newPasswords.map((p) => [p.name, p.username ?? '', p.email, p.role, p.team ?? '', p.password].join(',')))
      .join('\n');
    writeFileSync(out, csv + '\n', { mode: 0o600 });
    console.log('');
    ok(`password(s) for ${newPasswords.length} new account(s) written to ${out}`);
    note('This file is gitignored. Hand each password to its owner, then delete it.');
  }

  if (!APPLY) console.log(`\n${colour.YELLOW}Dry run only. Re-run with --apply to make these changes.${colour.OFF}`);
}

main().catch((err) => die(err.stack ?? String(err)));
