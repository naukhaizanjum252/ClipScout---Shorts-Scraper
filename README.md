# shorts-scraper

**Lucky35 / Luka.** Raised 2026-09-01 in Discord `#shorts`, thread "Scraper ( high prio )".
**Highest priority on the account.**

One action. Erik, 2026-09-02:

> *"I want to get 'get latest shorts' you scrape ALL platforms, come back with shorts over 500k
> views categorized by platform, AXE the rest."*

So: read the newest short-form videos from five platforms, keep the ones at or over **500,000
views** and at or under **120 seconds**, group them by platform, and print the links. Nothing else.

Plan: `C:\LUCKY35\work-to-be-completed\l35-shorts-scraper-2026-004.md`.

> **This README was rewritten on 2026-09-04 because it had stopped being true.** It documented
> `pnpm seed`, a `scripts/seed.ts` and a `lib/ingest/` that the pivot deleted, and a channel review
> queue this product no longer has. `package.json` still carried a `seed` script pointing at a file
> that was not in the tree. All of it was green, because nothing in a test suite reads the file a
> human pastes from. `tests/docs.test.ts` now does: every path, every `pnpm` command and every
> environment variable named here is checked against the tree on every run.

## The decision that shapes everything below — Erik, 2026-09-04

> *"We are going with ScrapeCreators"*

**ScrapeCreators is the data provider for Instagram, TikTok and Facebook.** Bright Data was offered
as the more reliable option and was declined at roughly eight times the price; the tradeoff was
accepted knowingly, and it is written down **once**, in plan amendment **A5** — a small vendor, an
indemnity that leaves platform-terms exposure with the client, liability capped at twelve months of
fees, and an Instagram leg their own status page shows breaking more often than any other. That is
the last time this repository argues about it. Nothing in the code re-opens it.

Three facts from that decision shape the build, and all three were re-fetched on 2026-09-04:

- **It bills per REQUEST, not per record.** One call returns a page of results for one credit
  (`scrapecreators.com`, `docs.scrapecreators.com/introduction`). $47 buys 25,000 credits, they do
  not expire, and there is no subscription. So discarding everything under 500,000 views is free —
  you pay to *ask*, not to *keep*. That inverts the cost model this repo was designed around for X,
  where the spend cap counts Posts **returned**.
- **It is a synchronous REST API.** GET, `x-api-key` header, answer in the response. No
  trigger/poll/snapshot cycle, no job store, no webhooks. It fits `ProviderClient` in
  `lib/platform/unavailable.ts` directly, which is the whole reason this is a small change.
- **It does not cover everything.** X stays on the official API — it is the only leg here with no
  third-party terms problem, and it already returns view count, duration and video URL in one
  response. Facebook is **page-seeded only**, because nobody sells Facebook Reels discovery, this
  vendor included. YouTube is unchanged and keyless.

**Nothing in this repository has ever been run against ScrapeCreators.** There is no key on this
machine. Every figure above is fetched documentation with a URL and a date, which is exactly the
category of claim amendment A3 already had to correct once.

---

## Try it right now, with no key and no setup

```bash
pnpm install
pnpm latest --help
pnpm latest
```

A bare run reads nothing, exits **1**, and prints five paragraphs saying why each platform could not
be read. That is the product working: *"could not be read"* and *"nothing over the threshold"* are
different facts, and a list that showed both as a blank space would be telling the client that
Instagram has no viral content.

Give YouTube something to read and it reads it, with **no key, no Google Cloud project and no
`.env` file**:

```powershell
$env:PLATFORM_SEEDS_YOUTUBE='@MrBeast'; pnpm latest --platform youtube --limit 8
```

```bash
PLATFORM_SEEDS_YOUTUBE="@MrBeast" pnpm latest --platform youtube --limit 8
```

**Measured on 2026-09-04 at 17:22 on this machine**, that printed 5 kept of 5 read — 150,000,000,
61,000,000, 45,000,000, 24,000,000 and 9,700,000 views, durations 33s to 74s, canonical
`youtube.com/watch` links — and exited 0. Nothing was written anywhere: with no Supabase project the
run stores into `lib/shorts/memory-store.ts` and says so at the top of the output.

`--estimate` prices a run and stops without making it, which matters because X bills per Post
returned. `--json` prints the whole report. `--download` resolves one media URL per platform on
demand and never stores it; a direct media URL is signed and expires, the post URL beside every row
is the address that survives.

## The five platforms: what works today, what needs which key, what cannot work at all

The tool names five platforms and reports a row for all five on every run, including the ones
nothing can read. A platform missing from the list is a platform the UI cannot even say it failed
to read.

| Platform | Works with no key? | What it needs | Ever run against the live service? |
|---|---|---|---|
| **YouTube** | **Yes, today.** yt-dlp, keyless (`lib/platform/youtube.ts`) | a seed list of channels, and nothing else | **Yes** — 2026-09-04 17:22, this machine, the output above. A key is an *upgrade*: it adds publish dates, which the keyless walk carried for none of the 137 uploads in `lib/platform/fixtures/ytdlp-uploads-137.json`. |
| **TikTok** | **Partly.** The keyless yt-dlp path (`lib/platform/tiktok.ts`) refreshes seeded creators; the vendor path adds discovery. | keyless: a seed list of `sec_uid`s. Vendor: a ScrapeCreators key — and then **no seed list is required at all**, because it has a trending feed and keyword/hashtag search. | **No.** A `yt-dlp -J` probe of a public TikTok post on 2026-09-04 failed on this machine with "Unexpected response from webpage request", and the vendor path has never been called. The adapter has never returned a row by either route. |
| **X** | **No, and there is no keyless fallback at all** — yt-dlp has no X user-timeline extractor. X API v2 recent search (`lib/platform/x.ts`, `lib/platform/x-client.ts`) | a bearer token **and** `X_SEARCH_QUERY` **and** `X_MAX_POSTS_PER_RUN`. It stays on the official API deliberately. | **No.** Written from the vendor documentation, tested against fixtures built from the documented response shapes. No X key exists on this machine. |
| **Instagram** | **No.** yt-dlp marks its own `instagram:user` extractor CURRENTLY BROKEN. The adapter is `lib/platform/instagram.ts`; the vendor reader is `lib/platform/scrapecreators.ts`. | a ScrapeCreators key and a seed list of creators. The **official** Meta credential slot still exists and is now the fallback and the record, not the route. | **No.** And this is the leg the vendor's own status page shows breaking most often — see below. |
| **Facebook** | **No**, by either route. Adapter `lib/platform/facebook.ts`, same vendor reader. | a ScrapeCreators key **and a list of Pages**. **It is page-seeded only and always will be.** | **No.** And two separate things are wrong with it even when it works — no discovery exists to buy, and the view counts cannot be trusted. |

> **THE VENDOR READER EXISTS AS A MODULE AND, AS OF 2026-09-04 17:36, THE REGISTRY DOES NOT
> CONSTRUCT IT.** `lib/platform/registry.ts` neither imports nor builds it at that timestamp, so
> Instagram, TikTok and Facebook still report themselves unavailable however good the client is and
> whatever key is saved. **That is the exact bug this repo already shipped once** — `new XClient`
> appeared nowhere in the tree while every X unit test passed — and it is why the paragraph below
> tells you to trust the registry test rather than this file.
>
> `lib/platform/scrapecreators.ts` is the `ProviderClient` implementation. What makes a platform
> actually *available* is `buildAdapters()` in `lib/platform/registry.ts` leasing the credential and
> passing that one client to the TikTok, Instagram and Facebook adapters — one client for three
> platforms, so there is one credit meter and not three. **`lib/platform/registry.ts` is the
> authority on whether that has happened; its header says so in as many words, and
> `lib/platform/registry.test.ts` asserts availability out of `buildAdapters()` rather than out of an
> adapter built by hand.** That test is there because an earlier round shipped 746 green tests over
> an adapter nothing ever constructed. Do not take this README's word for the wiring; run the
> registry test.

### What is genuinely impossible here, as opposed to merely unbuilt

Three of these are permanent and worth stating flatly, because each one is a thing somebody will
otherwise go looking for.

- **Nobody sells Facebook Reels discovery.** Not ScrapeCreators — its Facebook surface is profile-,
  post- and group-addressed with no search endpoint of any kind (`scrapecreators.com/facebook-api`,
  2026-09-04) — and not Meta, whose Graph reference documents *"You can't perform this operation on
  this endpoint."* under Reading for both `/{page-id}/videos` and `/{page-id}/video_reels`. The Meta
  Content Library, which does offer public-content search, is academic and non-profit only; Lucky35
  is ineligible, and routing an application through somebody eligible is not an option because the
  application carries an eligibility representation. **So Facebook only ever shows Pages somebody
  named. An empty Facebook result is usually an empty seed list, and the card has to say which.**
- **Facebook view counts may be off by an order of magnitude, and the vendor says so.** Verbatim from
  `docs.scrapecreators.com/v1/facebook/post`, read 2026-09-04: *"For some reels, view_count can be
  null or lower than the public Reels badge."* A local yt-dlp probe on 2026-09-04 returned **408
  views on a reel whose public badge read 9.8K** — roughly 24× low, in the direction that makes a
  viral video look dead. **A number that unreliable cannot be silently compared against a 500,000
  threshold.** It is labelled wherever it is shown, and a null is carried as unknown and rendered as
  an em dash, never as zero.
- **The Instagram leg will break periodically, and that must never read as "no Instagram reels over
  500k".** Counted off `scrapecreators.com/status` on 2026-09-04: Instagram endpoints appear in more
  of that vendor's incidents than any other platform's, and the most recent — **25–26 August 2026** —
  hit `/v1/instagram/user/reels`, the exact endpoint this build depends on. A vendor 5xx, a 402 (out
  of credits), a 401 (bad key), or a response that stopped carrying `play_count` must each fail
  loudly and by name. `[]` is a result; a broken upstream is a failure; on screen they are the same
  three words, and keeping them apart is what this whole repo is bent around.

### The Meta findings are kept, because they are the reason the vendor was bought

Read out of Meta's own references on **2026-09-04**, before the vendor decision. They stopped being
the route and did not stop being true, so they stay on `/admin/credentials` above the Save button —
an operator should read them *instead of* starting Business Verification, not two weeks into it.

- **Instagram media has no duration field.** Not "we did not request it" — there is no field on the
  media object. The 120-second ceiling, the only thing that defines a Short in this product, cannot
  be evaluated from official Instagram data at all. **The vendor route fixes exactly this:**
  `/v1/instagram/user/reels` carries `video_duration` alongside `play_count`
  (`docs.scrapecreators.com/v1/instagram/user/reels/`, 2026-09-04).
- **Instagram Hashtag Search — the only cross-account discovery Meta offers — returns no view count
  and no duration**, and is capped at 30 unique hashtags per rolling 7 days behind the restricted
  Instagram Public Content Access feature. Business Discovery returns view counts but is a *lookup*:
  it cannot find an account you have not named. View counts or discovery, never both.
- **Facebook's Graph reference documents no read on a Page's videos**, quoted above.

`lib/credentials/providers.ts` carries all of it in one table, alongside a `usedBy` field that names
what in this build actually spends each provider's key on a discovery run. It is prose rather than a
boolean so the claim can be checked by opening the module it names.

## The seam that was broken until 2026-09-04, and why it is the interesting part

The suite was 31 files, 746 tests, 0 failures, typecheck clean, build clean. **And almost none of it
could run.**

`new XClient` appeared nowhere in the tree. Not once. So the X adapter was always constructed with
`client: null` and reported *"no X credential is configured"* — permanently, whatever an operator
pasted on `/admin/credentials`. The Meta adapters were constructed with their legacy first argument
only, so the object carrying the token, the seeds, the operator's Instagram id and the shared call
budget was never passed; both reported themselves unavailable forever, and each built its own
200-calls-per-hour budget against what is actually **one** Meta app, so together they could exceed
it with neither brake firing. `runOnSchedule()` had no caller anywhere.

Every one of those units had a thorough test that constructed it by hand with a fixture and proved
it works. Not one asked whether the **application** ever builds one with real configuration.

The fix is in `lib/platform/registry.ts`, which is now the one place that both knows which platform
is which **and** builds each adapter with what it needs. Leasing a credential is async, so
`buildAdapters()` returns a promise — deliberately, because the alternatives are worse: a lazy
client that leases on first use would make X report *available* with no credential saved at all, and
a separate `resolveOptions()` step callers must remember to call is the exact shape of the bug being
fixed. Making the registry async means a caller that forgets **fails the build** instead of silently
getting a dead adapter.

**"Available" still proves nothing about the vendor.** Availability is answered locally and makes no
network call, because the cheapest thing X sells is a $0.005 request and a status page must not drip
money. It means "everything this deployment is responsible for is in place", not "the token works".

### What the first real token will settle, and nothing before it can

Nothing in this repo has been run against X, Meta or ScrapeCreators. **Two questions are load-bearing
and only a real call answers either.**

**One: is `media.public_metrics.view_count` populated for third-party X videos?** If it is null, the
500,000-view filter — the product's one promise — has nothing to filter on, and the X leg is a
discovery feed with no ranking signal.

**Two: what fraction of fetched rows actually clear 500,000 views?** Because ScrapeCreators bills per
*request* rather than per record, a low fraction costs far less than it would have under the other
vendor — you do not pay for the rows you discard. **But it still decides whether the product returns
anything worth reading.** A run that reads five platforms honestly and prints nothing is a working
tool and a useless report, and nobody knows which one this is until somebody looks. On Facebook the
question is worse than unanswered: the view counts may be an order of magnitude low, so a Facebook
row that fails the threshold may be a viral reel thrown away.

The X leg is built so its half of that is impossible to miss on the first run, inside one capped run
— a hundred Posts is fifty cents:

- **Is `media.public_metrics.view_count` populated for third-party posts at the access level Lucky35
  will hold?** It is documented as a public metric and the documented example carries a value. That
  is documentation, not evidence. A null view count is carried as **null**, never coerced to 0 and
  never substituted from `impression_count`, which is a different measurement. If X returns video
  posts and *not one* carries a view count, the adapter **throws** rather than rendering "nothing
  over 500,000 views", because that sentence would be a lie about the platform.
- **Is the Post fields parameter `tweet.fields` or `post.fields`?** X's OpenAPI spec and its own
  worked examples disagree. Getting it wrong loses every metric on the response. A 400 blaming the
  parameter retries once with the other spelling for free; a response that accepted it and ignored
  it throws and names `X_POST_FIELDS_PARAM`, because retrying that costs another page of paid reads.
- **Are expanded `includes.users` billed as User reads?** The price table does not say. `estimateUsd`
  reports a `low` and a `high` that differ by exactly that unanswered question. **The first invoice
  settles it.**

## Money, and what stops a run spending it

**There are two paid legs and they bill in opposite shapes.** That is not a detail; it is why one cap
cannot serve both.

| | **ScrapeCreators** (Instagram, TikTok, Facebook) | **X** |
|---|---|---|
| Unit | **a request** — one call returns a page | **a resource returned** — one Post |
| List price | $47 / 25,000 credits ≈ **$1.88 per 1,000 requests** | **$0.005 per Post** |
| What a 500k filter costs | **nothing extra.** Discarding is free; you pay to ask. | **everything you throw away**, because you paid per row to get it. |
| What a spend cap must count | **calls** | **rows** |
| Renewal | none. Credits do not expire, no subscription. | none. Credits, no contracts, no minimum spend. |

Read off `scrapecreators.com` and `docs.x.com/x-api/getting-started/pricing` on 2026-09-04. **Both
are price lists. Neither is an invoice, and no run has been made against either.**

**X bills $0.005 per Post RETURNED** — per resource, not per request — capped at 3,000,000 Post reads
per monthly billing cycle, which is roughly $15,000 and is a backstop rather than a budget. Read from
`docs.x.com/x-api/getting-started/pricing` on 2026-09-04. Two properties of the API cut it: the same
resource requested twice in 24 hours is charged once, and `/2/tweets/counts/recent` is a flat
$0.005 **per request** probe that says how much a query would return before you pay to return it.

So the query *is* the invoice, and neither `X_SEARCH_QUERY` nor `X_MAX_POSTS_PER_RUN` has a default
anywhere. An unconfigured X is unavailable and names the missing variable. A default query would be
a config file choosing what somebody's card is spent on; a default cap would be it choosing how much.

Nothing is scheduled by default either, in two independent places: `platform_schedule.enabled` is
`FALSE` for all five rows when the migration is applied and only a person can change it, and an
unattended trigger with no `CRON_SECRET` refuses.

**The button that spends money is gated on `isAdmin`, capped, and locked.** Until 2026-09-04 the
only thing between an HTTP POST to that server action and a bill was *"a viewer exists"* — any
signed-in member, no ceiling on `X_MAX_POSTS_PER_RUN`, and nothing stopping two presses paying
twice. Now: the metered actions require an admin, one press may authorise at most **100** billed
Post reads whatever the environment says, a run holds a lock, and there is a cooldown between runs.
The cap **only ever lowers** — a deployment that configured 40 keeps 40, one that configured 10,000
gets 100, and one that configured **nothing still gets nothing**, because inventing a cap for an
operator who never set one would start the meter on their behalf.

**The limit of that lock is written down rather than glossed:** it is a module-level flag, so it
serialises presses inside one server process and knows nothing about a second instance. That is a
real improvement over nothing and it is not a distributed lock. The durable one belongs in the
database beside the scheduler's — which cannot be reused as it stands, because it refuses any
platform whose schedule row is disabled, and a button that stops working until you configure the
scheduler is not a button.

## Configuration

`.env.example` holds **names only, never a value**, and carries the full argument for each one. The
defaults are chosen so that **a deployment with no `.env.local` at all still runs** — two platforms
read keylessly and the other three say on screen exactly what they are missing. A missing variable
never turns into a silent empty list; that is the one rule this repo turns on.

A number may have a default **when somebody with the authority to set it said it out loud, and not
when it was read off somebody else's documentation** (`lib/config.ts`). `SHORT_MAX_SECONDS` defaults
to 120 — Luka, 2026-09-01, *"2 minutes max is length"*. `MIN_VIEWS` defaults to 500,000 — Erik,
2026-09-02, the sentence at the top of this file. `YOUTUBE_DAILY_QUOTA_UNITS` has **no** default,
because every published figure is about somebody else's project.

`MIN_VIEWS=0` is **rejected** rather than read as "no threshold". It is a request to turn the
product's one promise off, far more likely to be a misread env file than an intention, and deleting
the filter should look like a code change.

Seeds are not deployment and they are not a chore either. As of 2026-09-05 the seed list is
**derived**: `shorts_scraper.refresh_auto_seeds()` recomputes, per platform, the top 200 creators by
views seen in the last seven days, out of the rows previous runs already stored in
`shorts_scraper.shorts`. The run path calls it before every run, so the week rolls on its own. Rows
it owns carry `source = 'auto'`; anything a person added stays `manual` and the sweep never touches
it.

**A rolling ranking is buildable honestly where a fixed "top 200" list is not.** Nobody sells a list
of the top 200 creators per platform, and typing one out would be inventing a ranking. This one
asserts nothing that was not observed by this deployment.

**Which platforms can fill their own list, and which cannot.** A derived list is empty on an empty
database, and a platform that can only be read *by* seed then never observes anything. TikTok,
Instagram and X break that deadlock themselves — they have seedless discovery (the vendor's TikTok
trending feed and keyword search, its Instagram reels search, and X's own search query), so the
first run returns rows and the rows name creators. YouTube breaks it only with a key, because the
keyless yt-dlp path walks a channel's uploads and cannot enumerate channels. **Facebook does not
break it at all**: Meta's Graph reference documents no read on a Page's video edges and no
public-content search, and no vendor sells Facebook Reels discovery, ScrapeCreators included. So
Facebook's list contains exactly the Pages somebody names, and if nobody names any it stays empty.
That is a fact about what is purchasable, not about effort.

**X takes no seed list.** It is searched, not enumerated, so it reads `X_SEARCH_QUERY`,
`X_MAX_POSTS_PER_RUN` and an optional `X_WINDOW_HOURS`. A `PLATFORM_SEEDS_X` line used to sit in
`.env.example` with nothing reading it; it has been removed and `tests/docs.test.ts` fails the build
if it comes back. The seed splitter breaks on whitespace as well as commas, which would have turned
`min_likes:20000 has:video_link -is:retweet` into four unrelated seeds.

**The vendor key is one credential covering three platforms, which no other name in this file is.**
`SCRAPECREATORS_API_KEY` is the development fallback — an operator's own goes on
`/admin/credentials` like every other key. Because one key serves three platforms, **one missing
value takes out Instagram, TikTok and Facebook at once**, and each of the three has to say so in its
own sentence rather than three cards sharing one.

**There is deliberately no `SCRAPECREATORS_BASE_URL`.** The origin is a constant in the code and the
client takes a `baseUrl` option; nothing reads an environment variable for it, so a line in
`.env.example` would be a name somebody could fill in, redeploy for, and watch change nothing —
exactly what `PLATFORM_SEEDS_X` was. The underlying risk is real even though the variable is not:
**every endpoint path in this build was read out of the vendor's documentation on 2026-09-04 and not
one has been called**, and a path that has moved fails at runtime looking exactly like a bad key.
Today, correcting one is a code change. The documented default is `https://api.scrapecreators.com`,
from the vendor's own published example — a documented default, not a measured one; nothing here has
resolved that host.

## The quota measurement is OUTSTANDING

`verify/fixtures/quota.json` does not exist. **Nothing has been measured.**

```bash
pnpm quota:selftest                              # ok   — proves the harness bites, offline
pnpm quota:check                                 # INERT — the keyless path spends no quota
pnpm exec tsx verify/quota.ts --check --strict   # FAILED — nothing has been measured
```

That red is the honest state, not a broken test, and no number written into the file would fix it:
there is no API key, and **the API does not report what a call cost** — no header, no field. An
observation can only come from a calibration burn or a Cloud console readback, and the recording
records which. `verify/fixtures/README.md` has the commands.

The published costs live in `lib/yt/cost.ts` as `declaredUnits`, explicitly labelled documentation
rather than measurement. Checked against Google's `determine_quota_cost` page on 2026-09-04, all
four operations this repo calls cost **1 unit each** — and the price is not the interesting part:

> "The search.list and videos.insert methods have their own quota buckets. Each of these methods has
> a default daily limit of 100 per day."

A project gets **two allowances that do not exchange**: 10,000 units a day shared by
`playlistItems.list`, `videos.list` and `channels.list`, and a separate ration of **100 `search.list`
calls a day**. **Search is rationed, not expensive.** Walking a named channel's uploads costs 1 unit
per 50 videos — effectively unlimited for this workload. Seeded reading scales for free; autonomous
discovery has to be budgeted in **calls**, and a quota increase on the 10,000 would not raise the
ceiling that actually binds.

> **Scar, 2026-09-04.** This repo previously declared `search.list` at **100 units** and reasoned
> everywhere from a "100× gap". True under an older quota model, false now; the conclusion it
> supported was right and still is. It was catchable *because* `lib/yt/cost.ts` labelled the figure
> as a published claim awaiting a measurement rather than as fact.

## Whose API key

**The operator's.** Whoever runs this tool creates their own developer project, generates their own
key, and pastes it into `/admin/credentials`. Their quota, their billing, their terms-of-service
exposure. No shared environment variable, and nobody's personal account underwriting everybody
else's traffic.

The key is stored encrypted (AES-256-GCM, key held outside the database in
`CREDENTIALS_ENCRYPTION_KEY`) and **is never shown again — not even to the person who pasted it.**
Three mechanisms, because one of them will eventually be undone by a well-meaning edit:

1. `MaskedCredential` has no field for a secret, so a display path physically cannot carry one.
2. Column-level grants: `authenticated` has SELECT on the display columns and **not** on
   `secret_ciphertext`, so a hand-written `select=*` returns the row without it.
3. Plaintext leaves the database only through `lease_api_credential()`, SECURITY DEFINER, granted to
   `service_role` alone — so an admin's browser session cannot reach a key even though the admin is
   the person who pasted it in.

**One credential is shared by three platforms, and that is new.** Every other key here is
per-platform because the account is. The ScrapeCreators key is not: it reads Instagram, TikTok and
Facebook. So a missing or wrong value takes out three platforms at once, a 402 stops all three at
once when the credits run out, and each of the three still has to explain itself in its own sentence
rather than three cards sharing one. The vendor documents 401 for a bad key and **402 for an empty
balance** (`docs.scrapecreators.com/introduction`, 2026-09-04) — two different problems with two
different fixes, and neither of them is "Instagram had no viral reels today".

A credential is more than one value for Meta: `lib/credentials/fields.ts` is the table that declares
every field each provider needs, and the fourth Instagram value is the one people forget. Business
Discovery is read *from* your own account node, not from a global search endpoint, so without the
operator's own IG professional account id there is no request to make.

Each slot has a **Test** button wired to one cheap documented call (`lib/credentials/checks.ts`),
and the page says which request it is about to make, where it is documented, what it costs and what
a pass would actually prove — because "makes a test call" is not something a person can consent to
on a page about billable APIs.

Supabase Vault would be better and is not available: no Supabase project exists for this repo, so
nothing here could verify the extension is installed. The trust assumption is stated in full in
`lib/credentials/secret-box.ts` — anyone holding both the database **and** the server's environment
has the plaintext.

### If `CREDENTIALS_ENCRYPTION_KEY` changes or is lost, every stored key is gone

There is no second copy and no re-wrap path; that is the point of holding it outside the database.
Every `secret_ciphertext` row becomes undecryptable at once, and the failure is not a warning at
deploy time — it surfaces later, as an ingest failing to lease a credential. Recovery is entirely
manual: every operator pastes their key in again. Generate it once, keep it where things that cannot
be regenerated are kept, and do not rotate it as routine hygiene without first accepting that cost.

## Where the data lands — DECIDED, but no project exists yet

Erik, **2026-09-02**, answering the plan's Q4:

> **LookUp Media's own Supabase, in a database shared with the account's other projects, one schema
> per tool.**

The reason is cost — a Supabase project per tool is $10/month each and there are a lot of tools —
and it has the same shape as the bring-your-own-key design: the client's account carries the data,
the billing and the ToS exposure.

**One schema per tool is what makes a shared database safe, and it is not optional.** Everything
this repo creates lives in `shorts_scraper`; nothing lives in `public`. The clients in
`lib/supabase/config.ts` are pinned to that schema, and `supabase-js` carries the schema in the
client's *type*, so a plain `SupabaseClient` — which defaults to `"public"` — will not compile
against them.

| | |
|---|---|
| **Isolated** | Tables, types, functions, triggers, grants. `anon` gets no `USAGE` on the schema at all, so PostgREST cannot reach a table here even before RLS is consulted. |
| **Still shared** | `auth.users` is per *database*. Anyone who signs up for a co-tenant app holds a valid JWT here too. They get nothing, because authorisation runs off `shorts_scraper.profiles` and there is deliberately no trigger creating one on signup — so `role_of()` returns null and every policy denies. That is the isolation boundary and it is one function deep. |
| **Still shared** | The service-role key is per *project*. A co-tenant holding it can read `shorts_scraper.api_credentials` — and gets **ciphertext**. |

### Two commands that will take the co-tenants down

- **`supabase config push`** replaces the remote project's settings with `supabase/config.toml`.
  `[api] schemas` is deliberately absent from that file for exactly this reason — listing it would
  reset the project's exposed schemas to this repo's list alone and every other app in the database
  would start returning PGRST106.
- **`supabase db reset`** destroys every co-tenant's data.

Exposing this schema is a one-line migration — `20260904_08_expose_schema.sql`, which sets
`pgrst.db_schemas` on the `authenticator` role and reloads PostgREST. The dashboard's Settings →
API → Exposed schemas control writes the same setting; doing it in SQL keeps it versioned with the
rest of the schema instead of living as a checkbox somebody has to remember. **The value is
absolute, not additive** — it replaces the whole list, which is why `public` and `graphql_public`
are repeated in it, and why a co-tenant schema would have to be added to that same line.

**Migrations are applied through the SQL editor, not by `supabase db push`.** The original reason
was that a shared database keeps one migration history and several repos would fight over it. This
project turned out to be dedicated rather than shared, so the reason now is narrower and simpler:
`db push` needs the database password, which lives in Erik's password manager and has never been
handled by this repo. `supabase/config.toml` stops a subtler version of the same problem — without
it the CLI walks up to the home directory and uses the link stored there, which points at an
unrelated project, so `supabase db push` from this repo would silently apply this schema to
somebody else's database.

### What has and has not been run against the real database

Applied and exercised on 2026-09-04, project ref `czesslsokncmiszipwah`: all ten migrations, and a
full round trip through `SupabaseShortsStore` — write, read back, re-write without duplicating,
delete. `anon` is refused at the schema (`permission denied for schema shorts_scraper`) with the
schema exposed, which is the layering working as designed.

That round trip found a defect no static review could have: `shorts.is_short` is a stored generated
column calling `short_max_seconds()`, migration 05 revoked EXECUTE on that function and granted it
back to nobody, and a stored generated column runs as the **inserting** role rather than the table
owner. Every insert into `shorts` had been failing since migration 05 shipped, for every role.
Migration 10 fixes it; `tests/migrations.test.ts` now asserts the general rule.

What is still unverified is the schema's *shape as Postgres holds it*. `verify/db.ts` is that audit
and it needs the database password — `pg_class`, `pg_policies` and `pg_proc` only travel over the
Postgres wire protocol, and no API key substitutes:

```bash
pnpm db:selftest                            # ok  — proves the CHECKS bite, offline
pnpm db:check      --db-url postgresql://…  # never run; read-only, safe on production
pnpm db:roundtrip  --db-url postgresql://…  # never run; every write rolled back
```

`--check` introspects `pg_proc`, `pg_policies`, `pg_class` and the table- and column-level ACLs —
19 checks covering the schema's acceptance criteria plus the shared-database consequences.
`--roundtrip` proves what a static read cannot, every behaviour inside a transaction that is always
rolled back. `--selftest` passes because 17 deliberate mutations of a healthy snapshot each turn a
specific check red — **that proves the checks work and proves nothing about any database**, and the
two results are printed differently on purpose.

`tests/migrations.test.ts` is the pre-commit guard, and its own header is honest about being a
static read of the SQL rather than a query against a live catalogue.

## The scheduled run

`runOnSchedule()` in `lib/shorts/schedule.ts` is one pass: claim what is due, run it, release,
report. Three things a scheduled run needs and an attended one does not — a record of when each
platform last ran, a lock so two overlapping fires cannot read the same platform twice, and a floor
on how often a platform may be read.

The lock is **one column**. `platform_schedule.claimable_after` carries both "a run is in flight"
and "the last run was too recent", so claiming is a single conditional UPDATE with one predicate;
Postgres re-evaluates it under a row lock, so of two fires racing exactly one gets a row back. Split
across two nullable columns joined by OR, the same claim is awkward through PostgREST and easy to
get subtly wrong — and getting it wrong means double-reading a metered API with nothing going red.

The lock **expires**, and the direction of the error is chosen: a worker that is killed never
releases, so a claim pushes `claimable_after` out by a TTL. Too short and a slow run is overtaken and
the platform is read twice; too long and a crashed platform sits idle. The second is recoverable by
pressing the button on `/admin/shorts`, the first costs money, so the TTL is generous.

A platform is stamped as fetched **only** when its outcome is `ok`. Stamping an unavailable platform
would make `last_fetched_ok_at` mean "we tried".

**A scheduled run refreshes a seeded list. On four of the five platforms it cannot grow one.**
Instagram and Facebook can only ever check the creators and Pages somebody named — and for Facebook
that is permanent, because no discovery exists to buy from anyone. YouTube's discovery is rationed at
100 `search.list` calls a day and is not built.

**TikTok is the exception, and it changed on 2026-09-04.** The keyless route cannot discover anything
— yt-dlp's `tiktok:tag`, `tiktok:sound` and `tiktok:effect` extractors are all marked CURRENTLY
BROKEN upstream, there is no trending extractor, and all three official TikTok APIs are closed to
this use. The vendor route can: ScrapeCreators sells a trending feed by region plus keyword and
hashtag search (`scrapecreators.com/tiktok-api`, 2026-09-04). **So TikTok is the one platform in this
product with real discovery, and a run must report *refreshed from the seed list* and *found by
searching* as two separate numbers.** Collapsing them into one would make a seeded refresh read as a
discovery, which is the exact claim this repo has spent two amendments refusing to make.

The proposal queue is the one weaker signal available elsewhere — a creator seen on one
platform very often uses the same handle on another — and **nothing is ever promoted
automatically**, because a proposal is a guess about *identity*: `@coffee` on TikTok and `@coffee` on
Instagram are frequently two unrelated people, and a wrong guess does not fail loudly. It quietly
fills the inventory with a different person's videos under a name the operator trusts.

### The door it did not have

`runOnSchedule()` was complete and tested and **nothing called it** — no route, no script, no
`vercel.json`, no workflow — and the only appearance of `CRON_SECRET` anywhere in the tree was a
paragraph in `.env.example` describing a refusal that did not exist. Every test called the function
directly, so the suite was green about a feature no deployment could reach.

`app/api/cron/run/route.ts` is the reachable end of it. GET and POST both work: GET because that is
what Vercel Cron sends, POST because it is the honest method for a call that spends money and writes
rows. From any other host it is one line:

```bash
curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" \
  "https://<deployment>/api/cron/run?slice=1"
```

`CRON_SECRET` is Vercel's name, not ours: setting an environment variable with that name makes
Vercel send its value as `Authorization: Bearer <value>` automatically. **Unset, blank, or shorter
than 16 characters answers 503 and never runs** — a one-character secret is not a smaller amount of
protection, it is a public URL with a formality in front of it. The presented value is compared in
constant time over SHA-256 digests rather than the strings, so neither the content nor the *length*
of the real secret leaks through response timing, and the comparison runs even when the header is
missing so a well-formed guess and a blank request take the same path.

The route is deliberately **not** under `/admin`, and that is checked rather than assumed: an
unattended caller has no browser, no cookie and no session to present, so a session gate would lock
out the only client this endpoint has. The bearer secret is the only gate and it fails closed. The
run then reaches the database as `service_role`, because `platform_schedule` is granted to
`authenticated` only behind `is_admin()` and there is no admin here to be — **the second use of the
service-role key in this repo**, where `lib/supabase/config.ts` still says the first should be the
only one. A `SECURITY DEFINER` claim function is the alternative; it is a migration that change did
not own, and it is noted rather than done.

**One fire does a slice of work.** `?slice=N` bounds how many platforms a single invocation will
claim and defaults to **one**, because a run stores everything in a single write at the *end* of the
pass — so an invocation killed halfway through five platforms loses the results of the ones that had
already finished, including, on X, results that were paid for. One platform per fire makes the unit
of loss one platform, and a host with real time should ask for `?slice=5`. Cut off mid-run, the
claimed platform stays locked until the TTL lapses (fifteen minutes), no report is written and no
shorts are stored — nothing partial, nothing corrupted, and never a duplicate charge. It is safe to
call again immediately and concurrently: the conditional claim is evaluated against **Postgres'**
clock rather than the caller's, so two hosts whose clocks disagree cannot both hold the same row.

**There is deliberately no `vercel.json`.** A Vercel cron must be declared there under `crons` and
the route alone does not create one; adding it would commit the repo to Vercel's cadence rules
before Erik has chosen a host, and strict JSON has no comment syntax, so the reasoning could not
travel with the file. When somebody does choose Vercel, the whole of it is:

```json
{ "crons": [{ "path": "/api/cron/run?slice=1", "schedule": "0 * * * *" }] }
```

plus `CRON_SECRET` in the Production environment. On the Hobby plan a cron may run **once per day**
at an unpredictable minute inside the scheduled hour, and a more frequent expression fails the
deploy outright.

**What one fire can cost, at the published rate and not as a measurement:** at most `slice`
platforms, each asked for at most 50 rows; of the five only X bills, so a default fire that happens
to pick X tops out at 50 × $0.005 = **$0.25**. A deployment that has enabled nothing spends nothing
however often it is called.

## Deploying

Vercel, on stock settings. Next.js 16 is detected from `package.json`, pnpm from `pnpm-lock.yaml`,
and the build command, output directory and function runtime are all inferred. `proxy.ts` is Next
16's replacement for `middleware.ts` and needs no declaration.

### The first deploy needs no environment variables at all

That is deliberate, and it is what lets the app go up **before** LookUp Media's Supabase project
exists. Each unconfigured path carries an explicit branch rather than a stub to be put back later:
`lib/auth/role.ts` returns no viewer, and `lib/credentials/resolve.ts` reports where a
key came from — with nothing set the answer is `none`. So the first deploy renders the shorts console,
states what it cannot see, and starts reading real rows the moment the variables are set.

**There is no sign-in, and `/admin` is open to anyone with the URL.** Erik's call, 2026-09-04. The
login page, the proxy redirect, the `SHORTS_PREVIEW` developer bypass and `lib/shorts/preview.ts`
were all deleted together, because a bypass around a gate that no longer exists is a switch that
reads as if it still controls access. `lib/auth/role.ts` is the one file that implements the
decision: it returns a frozen `owner` viewer with a null `userId`, so the call sites did not change.
`tests/admin-routes.test.ts` was **inverted rather than deleted** and now proves the opposite of
what it used to — every route under `app/(admin)` reachable with no cookies, no session and no
environment, and `proxy.ts` containing no redirect at all.

**State plainly what that costs, so it is not discovered later.** The protection on this deployment
is the secrecy of the URL and nothing else. Anyone with the link can trigger runs that spend metered
API quota, and can add or replace stored API keys. Stored secrets stay unreadable — they are
encrypted with `CREDENTIALS_ENCRYPTION_KEY`, which lives outside the database — but they can be
**replaced** by anyone who reaches the page. Audit columns record what happened and when, never who.
Restoring a gate means restoring the redirect in `proxy.ts` and `getViewer()` in `lib/auth/role.ts`
together; neither works alone.

| Variable | Set on Vercel | |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | yes, **public** | The project's address, not a permission. |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | yes, **public** | What protects the data is RLS and `anon` having no `USAGE` on the schema, never the secrecy of this string. |
| `SUPABASE_SERVICE_ROLE_KEY` | yes, **server only** | Bypasses RLS entirely. Read through `supabaseServiceRoleKey()` rather than exported as a constant, so an accidental client import cannot bundle it. |
| `CREDENTIALS_ENCRYPTION_KEY` | yes, **server only** | Set it in the same breath as the two Supabase variables: `resolveCredentialStore()` deliberately **throws** rather than falling back when Supabase is configured and this is missing. |
| `CRON_SECRET` | yes, **server only** | See above. |
| `X_SEARCH_QUERY`, `X_MAX_POSTS_PER_RUN` | yes, **if X is to run** | Not secrets, but X is unavailable without both. The app lowers the cap to its own ceiling whatever is set here, and never raises it. |
| `PLATFORM_SEEDS_*` | only with **no** database | With Supabase configured these are ignored: the seed list is derived from observed rows by `refresh_auto_seeds()`. |
| `SUPABASE_DB_URL` | **no** | Read only by `verify/db.ts`, a laptop tool. Setting it on Vercel puts a direct Postgres connection — one that reaches around PostgREST, RLS and every grant including the co-tenants' — into a web app's environment for no benefit. |
| `*_API_KEY` and the Meta app fields | **no** | Development fallbacks. `resolveCredentialStore()` refuses to read them when `NODE_ENV=production`, and never consults them once Supabase is configured. Operators supply their own on `/admin/credentials`. |

### Preview deployments will write to production unless you stop them

Vercel gives Preview and Development builds the same environment variables as Production unless each
variable is scoped. Left alone, a pull-request preview reads and writes the production inventory —
and because a run costs money on X, a branch that fires one is spending the client's card. Scope the
Supabase variables, `CREDENTIALS_ENCRYPTION_KEY` and `CRON_SECRET` to **Production only**. Previews
then fall back to the no-database state, which is still worth looking at.

A separate preview schema in the same database is the better option once there is anything to
preview against, but it is **not a checkbox today**: the schema name is a constant in
`lib/supabase/config.ts` on purpose, so a misconfigured deployment cannot point this app at a
co-tenant's schema. Making it configurable is a code change with its own argument to have.

### What does not run on Vercel

The admin surface is a fine Vercel app: request-shaped, short-lived, no background work.

**A paced, metered run fits badly.** `lib/shorts/schedule.ts` argues it in full — the run is a
process, not a request, and a serverless invocation cut off mid-flight leaves a platform's lock held
until the TTL lapses. `?slice=1` is the concession that makes it survivable there: one platform per
invocation, so the unit of loss is one platform rather than five. A GitHub Actions workflow on a
`schedule:` trigger needs no box and no request budget and leaves a log a person can open, which is
what you want the first time a metered platform behaves unexpectedly; a systemd timer on a box
somebody owns is the better answer the day there is a box. Both call the same URL with the same
header. **The exact host ceilings are unverified** — no vendor documentation was read for the
schedule module, so nothing there quotes a timeout or a delivery guarantee.

## What kind of short to look for

Luka, 2026-09-05, with a screenshot of the shorts page: *"we need to tell it what kinds of
shorts to look for ... for example we things like shark tank, top gear ... we need the scraper to
be able to search for those specific clips, not any random shorts with 500k+ views."*

Until then this tool could only be asked about SIZE — a view threshold and a duration window.
Nothing anywhere said SUBJECT, so a run returned the biggest Shorts on each platform, which is
what had been asked for and not what the client's plan needs: thirty niche channels, each fed by
one kind of clip.

A **topic** is a subject and the words that find it. The words are pushed DOWN into the source
rather than used to filter afterwards, because filtering afterwards fetches the same random
inventory and throws most of it away.

| Platform | Can it be searched for a subject? |
|---|---|
| YouTube | **Yes, keylessly.** `ytsearchN:<term> #shorts` through yt-dlp. Entries carry `duration`, `view_count` and `channel_id`, so a row is fully formed. No key, no quota, no billing. |
| TikTok | With a ScrapeCreators key — `/v1/tiktok/search/keyword`. There is no keyless alternative: yt-dlp's tag, sound and effect extractors are all marked CURRENTLY BROKEN upstream. |
| Instagram | With a ScrapeCreators key — `/v2/instagram/reels/search`. Note that endpoint publishes **no view count**, so its rows land in `unverified` rather than clearing the threshold. |
| X | With a bearer token AND a configured query. The topic is `OR`-grouped and ANDed onto `X_SEARCH_QUERY`, so it can only narrow — a topic run cannot cost more than the untargeted one. |
| Facebook | **Never, by anybody.** Meta's Graph API documents no public-content search and no read on a Page's video edges, and no vendor sells Facebook Reels discovery. It says so instead of returning an empty list. |

### The `#shorts` token is measured, not decorative

This machine, yt-dlp 2026.07.04, 2026-09-05, 100 entries pulled per query:

| query | ≤120s | and ≥500k views |
|---|---|---|
| `ytsearch100:shark tank #shorts` | 13 | 3 |
| `ytsearch100:shark tank shorts` | 6 | 2 |
| `youtube.com/hashtag/sharktank` | 0 | 0 |
| `?search_query=shark+tank&sp=EgIYAQ==` (YouTube's own "short" filter, which means under four minutes) | 1 of 7 | 0 |

**The yield is low and that is the honest number.** At a search depth of 60 per term against the
500,000-view threshold: Family Guy 32 rows, Top Gear 10, Shark Tank 2, Bodycam 2, Wholesome Animal
**0**. Named-IP subjects do well; vibe subjects do not, because there is not much 500,000-view
Shorts content about "wholesome animals" specifically. The answer to that is a lower threshold or
better terms for those topics, set by an operator — not a search that quietly widens until
something comes back.

### The rule that makes it trustworthy

**A platform that cannot be searched for a subject is reported as unavailable — never as an empty
result, and never by quietly falling back to its untargeted read.** That fall-back is the failure
worth naming: it would return the same everything-that-is-big list, now labelled with a subject
nobody searched for, which is worse than returning nothing. `lib/platform/topical.ts` is the seam
that enforces it and `lib/shorts/run-topics.test.ts` is the test that would catch it coming back.

`shorts.topic_slug` records which subject found a row. **Null means "no subject was asked for"** —
an untargeted read of a seeded channel — and never "the subject is unknown".

## The screens

| | |
|---|---|
| `/` | Not a page. A redirect straight to `/admin/shorts`. The landing page that used to be here was written for a signed-out visitor, and there is no longer such a person; it also kept a hand-written second copy of the per-platform readiness table, which the run itself reports. |
| `/admin/shorts` | The product: one button, one list, grouped by platform. It fetches nothing on load — a run costs quota and real money, and doing it on page load means every refresh and every prefetch spends that. The estimate beside it is a second button for the same reason in reverse. |
| `/admin/topics` | What kind of short to look for. Thirty subjects from the client's plan, each with the words that find it, editable. Nothing here spends anything — the page builds the adapters only to ask, locally, which platforms could be searched at all. |
| `/admin/credentials` | One slot per platform. Each carries the credential's real shape, a Test button, and the verified limits that decide whether the platform can serve this product at all. |

House style is `DESIGN.md`, ported from `impressions` so the two tools on this account look like one
product.

## Verify it yourself

```bash
pnpm install
pnpm test            # no network, no credentials
pnpm typecheck
pnpm db:selftest     # proves the live-database audit bites, offline
pnpm quota:selftest
pnpm build
```

`pnpm test` runs offline by design: everything under test is pure — duration parsing, the uploads
playlist walk, the cost table, the quota arithmetic, the adapters against fixtures, a static read of
the migrations, and now the documentation against the tree. Component tests opt into jsdom per file
rather than the whole suite paying for a DOM it does not use.

### What was actually run, and when

Every command in this file was pasted and run on **2026-09-04 between 17:18 and 17:34**, on Windows 11
with pnpm 10 and yt-dlp 2026.07.04. Nothing below is copied from an earlier README.

**Read the timestamps, because this file was written while other work was landing.** `pnpm test` was
run three times in eighteen minutes and the count went 905 → 974 → 975 — not because anything in this
document changed, but because the ScrapeCreators client and its tests arrived in the same round.
**A test count is a measurement with a clock time on it, not a property of the repository.** Re-run
it before repeating any number below.

| Command | Result |
|---|---|
| `pnpm test` | **35 files, 905 tests, 0 failures**, 3.37s, at **17:18** |
| `pnpm test` again | **36 files, 975 tests, 0 failures**, 4.02s, at **17:35** — the vendor client and its tests had landed |
| `pnpm exec tsc --noEmit` | **clean at 17:18. Red at 17:34**, with 4 errors, all of them in `lib/platform/registry.test.ts` and all of them the same one: `LatestShortsQuery` has no `platform` property. That file was being rewritten in another lane at that moment as the registry was wired to the vendor. It is a type error in a test, not a product defect — **and it must be green before anybody reports this round as done.** |
| `pnpm latest --help` | exit 0 |
| `pnpm latest` | exit **1**, five platforms reported unavailable with a reason each |
| `pnpm latest --platform youtube --limit 8` with `PLATFORM_SEEDS_YOUTUBE=@MrBeast` | exit 0, **5 kept of 5 read** — the run quoted at the top of this file |
| `pnpm db:selftest` | ok — **19 checks, 17 mutations**, every one bites |
| `pnpm quota:selftest` | all checks passed, no key, no network |
| `pnpm quota:check` | INERT, exit 0 |
| `pnpm exec tsx verify/quota.ts --check --strict` | **FAILED** — nothing has been measured, which is the honest state |
| `pnpm build` | **not run in this pass**, deliberately. It is the standard Next build and nothing here overrides it, but this README does not claim a green build it did not watch. |

**The two red tests and two type errors recorded here at 15:51 are fixed and gone.** They were
`lib/platform/x.test.ts` calling `adapterFor()` without awaiting it after `buildAdapters()` became
async, and `lib/credentials/credentials.test.ts` still asserting `usedBy` is `null` after that field
grew from a string into an object. Both were one line, both landed, and the 905 above is the count
with them in.

**Re-run `pnpm test` before trusting this table.** A count in a document is a measurement with a
timestamp on it, not a promise — which is precisely why `tests/docs.test.ts` exists.

## Handoff — picking this up cold

Written for an engineer who has never seen this repo. Read this section, then `DESIGN.md`, then
`lib/platform/registry.ts`. That is enough to be useful.

### What is built

- **One action, five platforms.** `scripts/latest.ts` on the command line and `/admin/shorts` in the
  browser both go through `buildAdapters()` in `lib/platform/registry.ts`, which is the only place in
  the tree that knows which platform is which or constructs an adapter. A test fails the build if
  something else starts to.
- **Five real adapters, none of them stubs.** YouTube and TikTok read keylessly through yt-dlp
  (`lib/platform/ytdlp.ts`). X has a full client written from the published API
  (`lib/platform/x-client.ts`). Instagram and Facebook are `ProviderBackedAdapter`s — see
  `lib/platform/unavailable.ts` — which refuse loudly and specifically when they hold no provider
  client, and start working the moment one is passed in through the registry.
- **A ScrapeCreators `ProviderClient`** in `lib/platform/scrapecreators.ts`, written from the vendor's
  documentation as fetched on 2026-09-04 — **and at 17:36 that day, not yet constructed by
  `lib/platform/registry.ts`.** So it is written, not wired. A client nothing constructs is the exact
  bug this repo already shipped once; `lib/platform/registry.test.ts` asserts availability out of
  `buildAdapters()` and is the only thing worth trusting about it. **Check that before believing any
  sentence in this file about Instagram, TikTok or Facebook working.**
- **Operator-supplied credentials, encrypted at rest**, never shown again to anyone including the
  person who pasted them: `lib/credentials/`, with plaintext reachable only through
  `lease_api_credential()` as `service_role`.
- **A schema, applied through the SQL editor** from `supabase/migrations/`. All ten are live on
  project `czesslsokncmiszipwah` as of 2026-09-04. Everything lives in
  `shorts_scraper`; nothing lives in `public`.
- **A scheduled run with a durable claim** (`lib/shorts/schedule.ts`) and the route that reaches it
  (`app/api/cron/run/route.ts`), gated on a bearer secret that fails closed.
- **Two offline audit harnesses**, `verify/db.ts` and `verify/quota.ts`, each with a `--selftest`
  that proves the checks bite without touching anything real.
- **Documentation tested like code.** `tests/docs.test.ts` reads this file, `.env.example` and
  `package.json` and fails the build when a path, a command or an environment variable named here
  stops being real.

### What has NEVER been run against a live API — which is every paid integration

**There are no API keys of any kind on this machine.** Not X, not Meta, not ScrapeCreators, not
YouTube. Everything below is written from published documentation and tested against fixtures built
from documented response shapes:

| | Status |
|---|---|
| **X API v2** | never called. Written from `docs.x.com`, fixtures only. |
| **ScrapeCreators** | never called. Endpoint paths, field names and prices read from their docs on 2026-09-04. |
| **Meta Graph (Instagram, Facebook)** | never called. Scaffolded so the credential slot and its Test button exist; the documented expectation for Facebook is a failure, and that failure is the deliverable. |
| **YouTube Data API v3** | never called. The keyless yt-dlp path *has* run, on this machine, today. |
| **Any Supabase project** | never connected. `SupabaseShortsStore`, the seed store, the schedule store and `SupabaseCredentialBackend` are all unexercised, and the migration audit is a static read of the SQL. |
| **Any deployment** | never deployed. There is no Vercel project and deliberately no `vercel.json`. |

Nothing in this repository may claim otherwise, and no figure in it may be repeated as measured.
`verify/fixtures/quota.json` is absent on purpose and `pnpm exec tsx verify/quota.ts --check --strict`
is red because of it. **That red is the honest state.**

### What is blocked, and on whom

| Blocked | On whom | What unblocks it |
|---|---|---|
| ~~Every database path~~ **UNBLOCKED 2026-09-04.** Persistence, seeds, the schedule and stored credentials all run against a live project. | — | Done. Ten migrations applied to `czesslsokncmiszipwah`, round trip verified, and the deployment reads and writes as `service_role`. What remains is the `verify/db.ts` catalogue audit, which needs the **database password** — see "What has and has not been run against the real database". |
| Instagram, TikTok discovery, Facebook | **whoever owns the client's accounts.** A ScrapeCreators key. | ten minutes and $47. `C:\LUCKY35\work-to-be-completed\shorts-scraper-API-SETUP.md` has the runbook in non-engineer language. |
| X | **the same person.** A bearer token from console.x.com, plus `X_SEARCH_QUERY` and `X_MAX_POSTS_PER_RUN`, neither of which has a default anywhere. | the token and two decisions: what to search for, and how much of somebody's card one press may spend. |
| Anything running unattended | **Erik.** The host is chosen and live — Vercel, at shorts-scraper.vercel.app. | `CRON_SECRET`, plus a `vercel.json` this repo deliberately does not carry. The endpoint refuses to run without the secret rather than running open. |
| The quota measurement | **an operator's own YouTube key** | `--probe`, then `--calibrate` or `--observe`. Nothing else produces the number, because the API does not report what a call cost. |

### The first three things to do, in order

1. **Finish wiring the vendor client, then get a key in and make one call.** Run
   `pnpm exec vitest run lib/platform/registry.test.ts` first: if `buildAdapters()` does not report
   Instagram, TikTok and Facebook as available given a saved ScrapeCreators credential, the client is
   written and not wired, and **that is the first commit** — one lease, one client, handed to all
   three adapters, in the shape `xClientFrom` already has. Then the key: ten minutes and $47, no
   application and no review, and it turns on three of the five platforms at once. The first real
   call also settles whether the endpoint paths in this build are still the vendor's, which is the
   single most likely thing to be wrong — **a moved path fails looking exactly like a bad key.** Do
   all of this before touching anything else; a wrong assumption here silently invalidates the
   Instagram, TikTok and Facebook work.
2. **Stand up the Supabase project.** Until then nothing persists, the derived seed list has nowhere to
   write, no credential can be stored, and every run stores into `lib/shorts/memory-store.ts` and
   evaporates. Run `pnpm db:selftest` first to see what the audit checks, then `pnpm db:check`
   against the real URL — it is read-only and safe on production. Watch the two commands in
   "Two commands that will take the co-tenants down" and do not run either.
3. **Spend fifty cents on X**, with a deliberately small `X_MAX_POSTS_PER_RUN`, and read one number
   off the result: how many returned video Posts carried a populated `view_count`. That is the
   answer to unknown number one below, and it decides whether the X leg is a ranked feed or an
   unranked one.

### The two unknowns those first calls settle

1. **Is `view_count` populated for third-party X videos?** Documented as a public metric; never
   observed. A null is carried as null, never coerced to zero and never substituted from
   `impression_count`. If X returns video Posts and not one carries a view count, the adapter throws
   rather than printing "nothing over 500,000 views", because that sentence would be a lie about the
   platform.
2. **What fraction of fetched rows clear 500,000 views?** Per-request billing means a low fraction
   costs much less than it would have under a per-record vendor — that is the main thing this
   provider choice bought. It still decides whether the product returns anything useful, and on
   Facebook it is compounded by view counts the vendor itself says may be null or an order of
   magnitude low.

**Neither number exists anywhere in this repo, and neither can be estimated from documentation.**
Anyone who writes one down without having made the call has done the thing this codebase is built to
prevent.

## Reuse

`twitch-faceless` is the architectural match (Python, so ported rather than imported): `tf/helix.py`
→ `lib/yt/client.ts`, `tf/channels.py` → `lib/platform/ytdlp.ts`, `tf/scan.py`'s cheap→expensive
screening → the playlist-then-videos walk. `impressions` is the house-stack reference, and its
grants audit — twelve of fifteen functions anon-callable because Postgres grants EXECUTE to PUBLIC
on creation *and* Supabase adds an `anon` grant on top — is mechanised here in
`tests/migrations.test.ts` and `lib/db-audit/`. `title-scraper` is **not** reusable: different
domain, `repo: null`, there is no code.

## Still unanswered by the client

1. Whose quota and billing for each platform *(the mechanism exists; the decision per platform does
   not)*, and whether anyone will file a quota increase.
2. nexlev MCP — dependency or option? He said "maybe use"; nothing else is recorded.
3. What "finds them by itself" means concretely — **now answerable on TikTok and only there.** The
   vendor sells a trending feed and keyword and hashtag search, so the question stops being "is
   discovery possible" and becomes "what should it search for, and how often". On Facebook it stays
   permanently unanswerable, because nobody sells Facebook discovery.
4. ~~Where the data lands~~ *(decided 2026-09-02)*; still open: who among ~40 people reads it,
   whether niche researchers may write to it, and a retention policy.
5. ~~Which third-party data provider~~ *(decided 2026-09-04: ScrapeCreators)*; still open: who holds
   that account and whose card tops the credits up.
6. The ToS position at this scale, in writing — **larger now, not smaller.** Two platforms are read
   through yt-dlp rather than an official API, and three more are now read through a vendor whose
   terms put platform-terms compliance and the indemnity on the client rather than on the vendor.
   Buying a provider moved the work; it did not move the exposure.
7. What "50 channels/day" actually consumes — it is a launch cadence, not a scrape rate.
8. Per-platform view thresholds. `MIN_VIEWS` is deliberately **one** number for all five platforms:
   a million views on YouTube is not a million on X, but nobody has told us what those numbers are,
   and inventing four of them would put a business judgement in a config file under cover of a
   default.

Inbound blockers: Luka owes more info; Cenri owes Erik the nexlev-MCP-into-Claude guide.
