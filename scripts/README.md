# User provisioning

`provision-users.mjs` creates the CRM's Supabase accounts from `users.json`:
an auth user per person, the matching `public.profiles` row, and the
`manager_id` link from each agent to their team lead.

That last link is the one that matters most. The RLS policies in
`schema-merchants.sql` gate every read and write through
`in_my_scope(owner_agent_id)`, which walks the manager chain in `profiles`.
Until the chain exists, saving a merchant fails with
`new row violates row-level security policy for table "merchants"`.

## Before running

1. Run the SQL migrations first — at minimum `schema.sql` and
   `schema-hierarchy.sql`, which create `profiles` and the RLS helper functions.
2. Check the four manager addresses in `users.json`. They were derived from the
   `first.last@paymob.com` pattern the agent list uses and are flagged
   `"emailVerified": false`. A wrong address creates an account nobody can use.
3. Confirm the `role` values match what `sees_all()` and `in_my_scope()` test
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
