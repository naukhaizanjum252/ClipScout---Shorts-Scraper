-- Operator-supplied API credentials. ONE KEY PER PROVIDER.
--
-- WHOSE KEY. The operator's. Whoever runs this tool creates their own account
-- with whatever upstream a platform needs, generates their own key, and pastes
-- it in here. Their project carries their quota, their billing and their terms-
-- of-service exposure. Nobody's personal account underwrites everybody else's
-- traffic, and there is no shared environment variable that could quietly
-- become that. Erik kept this system through the 2026-09-04 pivot for exactly
-- one reason, in his words: "the credentials part is fine for entering the
-- needed API keys in order to get the scraping done."
--
-- WHAT A PROVIDER IS NOW, AND WHY IT CHANGED
--
-- It used to be one value, 'youtube', because the tool read one platform. The
-- tool now reads five, and each of them authenticates against a different
-- upstream, so a single key cannot serve them. `credential_provider` is the
-- UPSTREAM A KEY AUTHENTICATES AGAINST.
--
-- IT IS A SEPARATE ENUM FROM shorts_scraper.platform ON PURPOSE. It was written
-- that way while the two value lists still matched exactly, on the argument
-- that "a platform is a place videos live; a provider is a place keys are
-- issued, and the two lists will not stay parallel". They stopped being
-- parallel on 2026-09-04 and this migration is where that lands: there are now
-- SIX providers for FIVE platforms.
--
-- THE SIXTH IS A VENDOR AND NOT A PLATFORM. 'scrapecreators' is a third-party
-- reseller whose ONE key reads TikTok, Instagram and Facebook. It is the case
-- the note further down this file predicted in advance — "if a third-party data
-- provider is ever chosen for one of these, it gets its own enum value and may
-- well serve several platforms at once" — and the prediction is now a value.
--
-- WHY IT IS NOT THREE PLATFORM-SHAPED ROWS. One key, one balance, one invoice.
-- Three rows would make an operator paste the same key three times, would let
-- the three copies disagree after a rotation, and would let the partial unique
-- index below promise "one active key per provider" while three providers all
-- drew on the same account. One vendor row is the only shape that can be
-- audited.
--
-- WHICH PLATFORMS THAT VALUE COVERS IS NOT RECORDED HERE, and that is
-- deliberate. It is `VENDOR_SERVES` in lib/credentials/types.ts, one table, in
-- the language that also builds the client and renders the page. A second copy
-- in SQL would be a second thing to keep in step with no test able to compare
-- them at runtime — and this database has never been applied to, so the SQL
-- copy would be the one that quietly went stale.
--
-- EDITED IN PLACE RATHER THAN ALTERED. `alter type ... add value` is the right
-- answer for a database that exists; not one migration in this directory has
-- ever been applied to any database, so layering an ALTER on top of a create
-- that has never run would leave two statements to read and one truth. The
-- moment any of this is applied anywhere, that stops being true and the next
-- value arrives as an ALTER.
--
-- WHERE EACH ONE STANDS, 2026-09-04, read out of the vendors' own references:
--
--   youtube    First-party Data API v3. A key is an upgrade, not a requirement.
--   x          First-party API v2, metered, and Erik is paying for it. It is
--              the one leg here with an official API that can return discovery,
--              a view count, a duration and a video URL in one response.
--   instagram  First-party Graph API. Business Discovery returns a named
--              account's media WITH view counts and WITHOUT any duration field
--              at all, so the Shorts ceiling cannot be evaluated from it.
--              Hashtag Search is the only cross-account discovery and carries
--              neither a view count nor a duration.
--   facebook   First-party Graph API, and the reference documents no read on
--              /{page-id}/videos or /{page-id}/video_reels for anyone.
--   tiktok     No official API open to this use at all. Read keylessly with
--              yt-dlp `tiktok:user`, which refreshes a seed list somebody
--              supplied and cannot grow one.
--
--   scrapecreators
--              NOT A PLATFORM. A third-party vendor, chosen by Erik on
--              2026-09-04, whose one key serves TikTok, Instagram and
--              Facebook — trending, keyword and hashtag discovery for TikTok,
--              reels for Instagram, page reels for Facebook. Billed per
--              REQUEST at one credit, credits bought outright and documented
--              as never expiring. It does NOT serve X, which keeps its own
--              API because that API returns the duration the vendor does not
--              sell for X, and it does not serve YouTube, which needs no key
--              at all.
--
-- So the enum is no longer "the two that work plus three waiting on a vendor".
-- It is five upstreams with five different answers plus one vendor that answers
-- for three of them, which is exactly why the shape of a credential is per
-- provider rather than one text column — see the `identifiers` column below.
--
-- THE PREDICTION THAT CAME TRUE. This paragraph used to end "NOBODY HAS NAMED
-- ONE, and nothing in this repo invents one", above a note that a chosen vendor
-- would get its own enum value and might serve several platforms at once. Erik
-- named one; the value above is that note being honoured rather than a new
-- idea. A SECOND vendor follows the same rule and gets its own value; it never
-- shares this one, because a shared value would make two invoices
-- indistinguishable in the credential table.
--
-- THE SECRET NEVER REACHES A BROWSER. Not an admin's browser either — the
-- person who pasted it in cannot read it back. Three independent mechanisms,
-- because one of them will eventually be undone by a well-meaning edit:
--
--   1. It is stored ENCRYPTED. `secret_ciphertext` is AES-256-GCM, sealed by
--      the application with a key held outside this database in the server's
--      CREDENTIALS_ENCRYPTION_KEY. A database dump alone yields nothing.
--      (Supabase Vault would be better and is not available: no project
--      reference has been handed over yet, so nothing here could verify the
--      extension is installed. It is also a smaller win than it looks in a
--      SHARED database, where Vault's keys sit in the same project every
--      co-tenant's service-role key can reach and this encryption key does not.
--      See lib/credentials/secret-box.ts for the trust assumption, plainly.)
--   2. COLUMN-LEVEL grants. `authenticated` is granted SELECT on the display
--      columns and NOT on `secret_ciphertext`. A hand-written `select=*`
--      returns the row without it. This is the mechanism that does not depend
--      on any application code asking nicely.
--   3. RLS with no anon policy, and EXECUTE revoked from both PUBLIC and anon
--      on every function here.
--
-- The plaintext leaves the database through exactly one door:
-- `lease_api_credential()`, SECURITY DEFINER, granted to `service_role` alone —
-- a role that exists only inside a server process that is about to make an API
-- call.

-- FIVE PLATFORMS AND ONE VENDOR. The order matches CREDENTIAL_PROVIDERS in
-- lib/credentials/types.ts, and tests/migrations.test.ts compares the two lists
-- so a value added to one and not the other fails the build rather than failing
-- an insert on the day somebody first saves a key.
create type shorts_scraper.credential_provider as enum ('youtube', 'tiktok', 'instagram', 'x', 'facebook', 'scrapecreators');
create type shorts_scraper.credential_status   as enum ('active', 'disabled');

create table shorts_scraper.api_credentials (
  id                uuid primary key default gen_random_uuid(),
  provider          shorts_scraper.credential_provider not null,
  label             text not null check (btrim(label) <> ''),

  -- The sealed key. Envelope format `v1.<iv>.<tag>.<ciphertext>`, all base64url,
  -- with the row id as additional authenticated data — so a ciphertext lifted
  -- from one row and pasted into another does not decrypt.
  --
  -- It holds a JSON OBJECT of every sealed field, keyed by field id --
  -- {"access_token": "...", "app_secret": "..."} — rather than one value. One
  -- envelope per credential and not one per field, so a single auth tag and a
  -- single AAD bind the whole set: an attacker with write access cannot lift a
  -- valid app_secret off one row onto another row's access_token and have both
  -- still decrypt.
  --
  -- NEVER SELECT THIS COLUMN except through lease_api_credential().
  secret_ciphertext text not null,

  -- What the UI shows instead: eight dots and the last four characters. The dot
  -- count is fixed, so the mask does not leak the key's length.
  masked            text not null,

  -- THE NON-SECRET HALF OF A CREDENTIAL, READABLE ON PURPOSE.
  --
  -- Added 2026-09-04, when a credential stopped being one string. A Meta
  -- credential is four values, and only two of them are secrets: `debug_token`
  -- cannot be called without an app id, and Business Discovery cannot be called
  -- without the operator's own Instagram business account id. Neither is a
  -- secret — an app id appears in every Meta login dialog — and both are
  -- exactly the values an operator needs to SEE to know they pasted the right
  -- app.
  --
  -- So the split is per FIELD, not per credential: sealed fields go into
  -- secret_ciphertext as one JSON envelope, non-secret ones live here in the
  -- clear and are granted to `authenticated` alongside `masked`. Storing an app
  -- id encrypted would be theatre with a real cost — the operator could never
  -- check it, and every support conversation about which app a key belongs to
  -- would end in deleting the credential.
  --
  -- A JSONB OBJECT AND NOT A COLUMN PER FIELD, because the field set is per
  -- provider (see lib/credentials/fields.ts) and a column per provider's fields
  -- would mean a migration every time a vendor is added, on a table whose
  -- column grants are enumerated by hand. The check keeps it an object so a
  -- reader never has to handle an array or a bare scalar.
  identifiers       jsonb not null default '{}'::jsonb
                    check (jsonb_typeof(identifiers) = 'object'),

  status            shorts_scraper.credential_status not null default 'active',
  created_at        timestamptz not null default now(),
  created_by        uuid references auth.users(id) on delete set null,
  last_used_at      timestamptz,

  -- "Test this key" makes one cheap real call and records pass/fail. The error
  -- is scrubbed by the application before it gets here (lib/credentials/mask.ts)
  -- because upstream 400/403 bodies echo the request back often enough that it
  -- is not theoretical.
  last_check_ok     boolean,
  last_check_at     timestamptz,
  last_check_error  text,

  -- The daily unit allowance OF THIS CREDENTIAL'S OWN PROJECT, as read off that
  -- operator's console. NULL until somebody reads it. There is no default here
  -- and none in lib/config.ts either: a daily-quota number that is not a
  -- measurement is exactly what this project refuses to hold.
  daily_quota_units integer check (daily_quota_units is null or daily_quota_units > 0)
);

-- One live key per upstream. Rotating means adding the new one and disabling
-- the old, never editing a secret in place.
create unique index api_credentials_one_active_per_provider
  on shorts_scraper.api_credentials (provider)
  where status = 'active';

comment on column shorts_scraper.api_credentials.provider is
  'The upstream this key authenticates against. Five values are platforms whose own API we call; scrapecreators is a VENDOR whose one key serves TikTok, Instagram and Facebook. Deliberately not the same type as shorts_scraper.platform - the two lists stopped being parallel on 2026-09-04. Which platforms a vendor covers is declared once, in lib/credentials/types.ts, and not copied here.';

comment on column shorts_scraper.api_credentials.secret_ciphertext is
  'AES-256-GCM sealed JSON object of every secret field, keyed by field id. Not selectable by `authenticated` (see column grants below). Read only via lease_api_credential().';

comment on column shorts_scraper.api_credentials.identifiers is
  'The NON-SECRET fields of a credential, keyed by field id: Meta app id, Page id, Instagram business account id. Readable by `authenticated` on purpose - an operator must be able to check which app a key belongs to. A secret never belongs here; lib/credentials/fields.ts decides which field is which.';

-- ---------------------------------------------------------------------------
-- Per-credential quota accounting
-- ---------------------------------------------------------------------------
--
-- Quota is per upstream project and, for the one metered API this tool has
-- actually measured, resets daily on Pacific time — so a global counter would
-- be wrong in two directions at once. One row per credential per quota day.
-- This survives the pivot unchanged because it was never about YouTube: it is
-- what any metered API costs, counted against the key that paid for it.

create table shorts_scraper.credential_quota_days (
  credential_id uuid not null references shorts_scraper.api_credentials(id) on delete cascade,
  quota_date    date not null,
  units_spent   integer not null default 0 check (units_spent >= 0),
  updated_at    timestamptz not null default now(),
  primary key (credential_id, quota_date)
);

-- ---------------------------------------------------------------------------
-- Column grants — the mechanism that does not rely on code asking nicely
-- ---------------------------------------------------------------------------
--
-- Postgres checks column privileges independently of RLS. Revoking table-wide
-- SELECT and granting it back column by column means `secret_ciphertext` is
-- unreachable by `authenticated` even with a hand-written PostgREST query, even
-- if a future RLS policy is written too loosely.
--
-- CONSEQUENCE WORTH KNOWING BEFORE IT BITES: a column added to this table later
-- arrives with NO grant and is invisible to `authenticated` until it is named
-- here. That is the safe direction to fail in, and it is the reason no other
-- table in this schema is granted column by column.

revoke select on shorts_scraper.api_credentials from authenticated;

grant select (
  id, provider, label, masked, identifiers, status, created_at, created_by,
  last_used_at, last_check_ok, last_check_at, last_check_error, daily_quota_units
) on shorts_scraper.api_credentials to authenticated;

-- INSERT must include the ciphertext (the admin's session is what saves a new
-- key), so insert keeps the column. Reading it back is what is closed, and the
-- table has no SELECT grant on it for any role but the owner and service_role.
grant insert (
  id, provider, label, secret_ciphertext, masked, identifiers, status, created_at, created_by, daily_quota_units
) on shorts_scraper.api_credentials to authenticated;

grant delete on shorts_scraper.api_credentials to authenticated;

-- UPDATE, AND ONLY THE FOUR COLUMNS THE SERVER WRITES BACK AFTER A CALL.
--
-- SCAR, 2026-09-04 review. There was no UPDATE grant here and no UPDATE policy
-- in migration 04, and the comment there said so as though it were a decision:
-- "`last_used_at` and the check results are written by the server". They are —
-- by `SupabaseCredentialBackend.patchRow`, which runs on the ADMIN'S SESSION
-- CLIENT, as `authenticated`. So every `noteCheck` and every `noteUse` would
-- have been refused by Postgres before RLS was ever consulted, and the refusal
-- travels: `testCredentialAction` puts the store's error message on the
-- credentials screen, so an operator pressing "Test this key" would have paid
-- for a real call to X or Google, got a valid answer, and then been shown a
-- PostgREST permission error naming a column they have never heard of. The key
-- would have looked broken when the grant was.
--
-- WHICH COLUMNS, AND WHY NOT `for update` ON THE WHOLE ROW. A column-level
-- grant is the tool this table already uses, for this exact reason: Postgres
-- checks column privileges independently of RLS, so naming four columns means
-- `secret_ciphertext` cannot be rewritten from a browser session even if a
-- future UPDATE policy is written too loosely. An admin session may record what
-- happened when a key was used. It may not touch the key, the provider it
-- belongs to, the label, the identifiers, or the quota figure — every one of
-- those is set once at insert and rotated by delete-and-add, which is the rule
-- the partial unique index above exists to hold.
--
-- CONSEQUENCE, in the same direction as the SELECT grant above: a column added
-- later is NOT updatable by `authenticated` until it is named here, and
-- tests/migrations.test.ts fails the build if the application starts writing a
-- column this list does not carry.
grant update (
  last_used_at, last_check_ok, last_check_at, last_check_error
) on shorts_scraper.api_credentials to authenticated;

-- ---------------------------------------------------------------------------
-- The one door to plaintext
-- ---------------------------------------------------------------------------

-- THE IDENTIFIERS COME BACK WITH THE SECRET, from this one call.
--
-- They could have been read separately through the admin's session, since the
-- column is granted to `authenticated`. But a lease taken by a background job
-- has no session, and it would then hold a Meta access token without the app id
-- that token has to be sent with — a null nobody would predict, discovered at
-- the request. One call returns a usable credential or nothing.
create function shorts_scraper.lease_api_credential(p_provider shorts_scraper.credential_provider)
  returns table (id uuid, label text, secret_ciphertext text, identifiers jsonb)
  language sql
  security definer
  set search_path = shorts_scraper, public
as $$
  select c.id, c.label, c.secret_ciphertext, c.identifiers
    from shorts_scraper.api_credentials c
   where c.provider = p_provider
     and c.status = 'active'
   order by c.created_at desc
   limit 1
$$;

comment on function shorts_scraper.lease_api_credential(shorts_scraper.credential_provider) is
  'Returns the sealed key for the active credential of one provider. service_role ONLY - never anon, never authenticated. The application decrypts it in-process for one outbound call.';

-- Bump a credential's spend for the day. Called by the server after a run.
create function shorts_scraper.record_credential_units(
  p_credential_id uuid,
  p_units integer,
  p_quota_date date default (now() at time zone 'America/Los_Angeles')::date
)
  returns integer
  language sql
  security definer
  set search_path = shorts_scraper, public
as $$
  insert into shorts_scraper.credential_quota_days (credential_id, quota_date, units_spent)
  values (p_credential_id, p_quota_date, greatest(p_units, 0))
  on conflict (credential_id, quota_date) do update
    set units_spent = shorts_scraper.credential_quota_days.units_spent + greatest(excluded.units_spent, 0),
        updated_at  = now()
  returning units_spent
$$;

-- ---------------------------------------------------------------------------
-- Grants — BOTH DOORS. PUBLIC and anon, every time.
-- ---------------------------------------------------------------------------

revoke execute on function shorts_scraper.lease_api_credential(shorts_scraper.credential_provider) from public, anon, authenticated;
revoke execute on function shorts_scraper.record_credential_units(uuid, integer, date) from public, anon, authenticated;

grant execute on function shorts_scraper.lease_api_credential(shorts_scraper.credential_provider) to service_role;
grant execute on function shorts_scraper.record_credential_units(uuid, integer, date) to service_role;

notify pgrst, 'reload schema';
