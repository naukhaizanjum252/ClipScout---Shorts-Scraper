# verify/fixtures — quota measurement

## Status: **UNRECORDED**

`quota.json` (the recording) and `quota-report.json` (the derived report) are
**absent**, deliberately. Nothing has been measured.

`pnpm exec tsx verify/quota.ts --check --strict` is therefore **red**, and that
red is the honest state of this project rather than a broken test — the same
convention as `l35-manhwa-image-only-tool-2026-001`.

## Why it is unrecorded

Two reasons, and neither of them can be fixed by writing a number in here.

1. **There is no API key.** Whose Google Cloud project pays for the quota is
   open question Q1(b) in the plan and the client has not answered it. The
   mechanism now exists — an operator saves their own key on
   `/admin/credentials` and it is stored encrypted, per-tenant — but no key has
   been saved, and none exists in this repository or anywhere near it.
2. **The API does not report what a call cost.** There is no units-consumed
   header and no field in the response body. An observation can therefore only
   come from one of two methods, and the recording records which one was used:
   a **calibration burn** (call until 403 `quotaExceeded`, divide the project's
   configured daily allowance by the calls that succeeded) or a **console
   readback** (issue a known batch, read the consumed-units figure off Google
   Cloud's quota page).

**A plausible number written in here would be worse than no number**, because
it would be quoted in a client conversation as though somebody had checked. The
published figures live in `lib/yt/cost.ts` as `declaredUnits`, explicitly
labelled as documentation and not measurement, and Phase 0 exists to replace
them with observations.

> **This paragraph used to state those figures itself, and got them wrong.** It
> said `search.list` cost 100 units against 1 for the other three. Google's
> quota page, read on 2026-09-04, prices **all four at 1 unit** — `search.list`
> is not expensive, it is *rationed*: it draws on its own bucket with a default
> ceiling of **100 calls a day**, which cannot be topped up from the 10,000
> units the other operations share. The repo's conclusion never changed — walk
> a channel's uploads playlist, do not enumerate through search — but its
> reason did, from a unit price to a hard call ceiling.
>
> The lesson is the one this file already argues for, arriving from an
> unexpected direction. The figure survived long enough to be repeated to the
> tech lead in conversation, and what caught it was `cost.ts` labelling it a
> claim rather than a fact. Restating a number here instead of pointing at the
> one place that owns it is the mistake. Do not reintroduce it.

## Note: quota is per credential, not global

Every operator brings their own Google Cloud project, so a measurement is only
ever a fact about **one** credential. The recording carries a `credential` block
naming which — identity only, never the key. A second operator needs their own
recording; theirs does not describe this one's allowance.

## How to record it

With a key saved (`/admin/credentials`, or `YOUTUBE_API_KEY` in `.env.local`
for local work):

```bash
# 1. Prove each of the four operations really runs, and save the evidence.
#    observedUnits stays null — a probe shows the call happened, not its cost.
pnpm exec tsx verify/quota.ts --probe

# 2a. Read the consumed-units figure off the Cloud console and record it,
#     with the URL it came from. Cheap, and the recommended route.
# The value below is a PLACEHOLDER showing the command's shape. Record what
# the console actually showed you, never what you expected to see — an
# observation copied from the declared figure proves nothing at all.
pnpm exec tsx verify/quota.ts --observe search.list=<what the console said> \
  --source "console.cloud.google.com/.../quotas after N calls on 2026-09-XX"

# 2b. Or burn a day's quota to measure one operation directly.
#     Needs YOUTUBE_DAILY_QUOTA_UNITS (or the credential's daily_quota_units).
pnpm exec tsx verify/quota.ts --calibrate search.list \
  --i-understand-this-spends-the-days-quota

# 3. Then this goes green.
pnpm exec tsx verify/quota.ts --check --strict
```

## Inert on the keyless path

The default source adapter is `ytdlp`, which spends no quota, needs no key and
bills nobody. `--check` reports **INERT** and exits 0 there, because a keyless
run must not require — and must not pretend to have — a quota recording. Pass
`--strict`, or set `SOURCE_ADAPTER=api`, to require a real measurement.

"The check passed" and "the check did not apply" are printed differently on
purpose.
