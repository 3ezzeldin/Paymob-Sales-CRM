# User provisioning

`provision-users.mjs` creates the CRM's Supabase accounts from `users.json`:
an auth user per person, the matching `public.profiles` row, and the reporting
links up the chain.

The roster has three tiers, matching what the CRM enforces on import:

| Tier | Roles | Reports to |
|---|---|---|
| `seniors` | Admin, Sales Director, Head of Sales | nobody |
| `managers` | Area Manager | a senior, via `reportsTo` — required |
| `agents` | Agent | an Area Manager, via `manager` |

A senior marked `"existing": true` is never created. The script looks them up by
email and uses their id for the links, leaving their profile untouched. That is
the normal case: the people at the top already have accounts.

That last link is the one that matters most. The RLS policies in
`schema-merchants.sql` gate every read and write through
`in_my_scope(owner_agent_id)`, which walks the manager chain in `profiles`.
Until the chain exists, saving a merchant fails with
`new row violates row-level security policy for table "merchants"`.

## Before running

1. Run the SQL migrations first — at minimum `schema.sql` and
   `schema-hierarchy.sql`, which create `profiles` and the RLS helper functions.
2. Replace every `TODO` in `users.json` with the senior names and emails exactly
   as the CRM stores them. The script refuses to run while any remain.
3. Check the four manager addresses. They were derived from the
   `first.last@paymob.com` pattern the agent list uses and are flagged
   `"emailVerified": false`. A wrong address creates an account nobody can use.
4. Confirm the `role` values match what `sees_all()` and `in_my_scope()` test
   for. The defaults are `Agent` and `Manager`.

## Running

```bash
export SUPABASE_URL=https://<project-ref>.supabase.co
export SUPABASE_SERVICE_ROLE_KEY=<service role key>    # Settings > API > service_role

node scripts/provision-users.mjs            # dry run: reports what it would do
node scripts/provision-users.mjs --apply    # create the accounts
```

The service role key bypasses row-level security entirely. Keep it in your
shell, out of the repository, and off any shared channel.

### Options

| Flag | Effect |
|---|---|
| `--apply` | Actually write. Without it the script only reports. |
| `--passwords <file.csv>` | Use passwords from a CSV (needs an email column and a password column) instead of generating new ones. |
| `--agents-only` | Skip the managers, e.g. when they already have accounts. |
| `--roster <file.json>` | Use a different roster file. |

## Afterwards

New passwords are written to `credentials.local.csv` in the repository root,
mode 0600 and gitignored. Distribute each one to its owner, then delete the file.

Every account is created with `user_metadata.must_change_password = true`.
Supabase has no built-in forced-reset flag, so the app has to read that field
after sign-in and route to a change-password screen before anything else.
Until it does, the flag is a note rather than an enforcement.

Re-running is safe. An email that already has an auth user is reused with its
password untouched, and the profiles upsert merges on `id`.

---

# Joiners, movers and leavers

`manage-users.mjs` applies the changes in `changes.json`: `add` creates an
account, `move` changes someone's team and reporting line, `offboard` hands
their book of business to a successor and then disables them.

```bash
node scripts/manage-users.mjs            # dry run, reports what it would do
node scripts/manage-users.mjs --apply
```

`who`, `reportsTo` and `reassignTo` match against any text field on a profile,
so a username, a full name or an email all work. The email is safest when two
people share a name; an ambiguous match stops the run rather than guessing.

## Why a leaver is deactivated, not deleted

`merchants.owner_agent_id` is declared `references profiles(id) on delete set
null`, and the select policy is `sees_all() or in_my_scope(owner_agent_id)`.

Delete a profile and every merchant that person owned keeps its row but loses
its owner. `in_my_scope(null)` matches nobody, so those merchants disappear
from the CRM for everyone except an admin or director. Nothing errors. The
pipeline simply gets smaller, and the first person to notice is whoever goes
looking for an account that used to be there.

So the default is to reassign the leaver's merchants and activities to a named
successor, mark the profile inactive, and ban the auth user so they cannot sign
in. The account stays as the audit trail for the activity history.

`--delete` removes the auth user outright. It refuses to run unless a successor
is named and the reassignment has already succeeded.
