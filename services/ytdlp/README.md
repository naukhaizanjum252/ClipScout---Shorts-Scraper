# The yt-dlp service

A small HTTP wrapper around a real `yt-dlp`, for hosts that cannot spawn one.

**You need this only if the app runs somewhere without `yt-dlp` on PATH.** On a
laptop, or any VPS where you can `apt install yt-dlp`, you do not: leave
`YTDLP_SERVICE_URL` unset and the app spawns the binary directly.

You do need it on **Vercel**, which has neither `yt-dlp` nor a way to install it.

## Why it cannot be skipped by buying an API key

YouTube discovery is *entirely* keyless yt-dlp. The YouTube Data API key is an
upgrade, not a substitute: it hydrates rows yt-dlp has already found — publish
dates, likes, comments — and **cannot enumerate a channel at all**. Without a
working yt-dlp somewhere, YouTube returns nothing no matter what keys are set.
TikTok's keyless path is the same.

## Deploy it

The image is a `Dockerfile`, so anything that runs a container will do. Two that
cost nothing at this size:

**Fly.io**

```bash
cd services/ytdlp
fly launch --name shorts-ytdlp --no-deploy
fly secrets set YTDLP_SERVICE_TOKEN="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")"
fly deploy
```

**Google Cloud Run**

```bash
cd services/ytdlp
gcloud run deploy shorts-ytdlp --source . --allow-unauthenticated \
  --set-env-vars "YTDLP_SERVICE_TOKEN=<the token you generated>"
```

`--allow-unauthenticated` is safe here only because the service does its own
bearer check and **refuses to start without a token of at least 16 characters**.

## Point the app at it

Set both, in Vercel's project settings, as **Config** (not Secret — see the note
in `.env.example`):

```
YTDLP_SERVICE_URL=https://shorts-ytdlp.fly.dev
YTDLP_SERVICE_TOKEN=<the same token>
```

**Both or neither.** A URL without a token cannot authenticate; a token without
a URL has nowhere to go. Either alone reads as "not configured" and the app
falls back to spawning a binary that is not there — which would report the wrong
reason for an empty list.

## Check it

```bash
curl https://shorts-ytdlp.fly.dev/health
```

```bash
curl -X POST https://shorts-ytdlp.fly.dev/run \
  -H "authorization: Bearer $YTDLP_SERVICE_TOKEN" \
  -H "content-type: application/json" \
  -d '{"args":["--version"]}'
```

The second should return `{"stdout":"2026.07.04\n"}`. A 401 means the token
disagrees; a 400 means the argv was refused, which is the service working.

## What it will and will not run

It does **not** filter the argv — it **rebuilds** it. A request is matched
against the three commands the application actually issues, and a fresh argv is
constructed from the validated parts:

```
--flat-playlist -J --no-warnings --playlist-end <N> <TARGET>
--no-warnings --no-playlist -f best[ext=mp4]/best --print urls <URL>
--version
```

Anything else is a 400. That matters more than it might look: `yt-dlp --exec`
runs a shell command, `-o` writes a file, `--cookies` reads one. An allowlist of
forbidden flags would have to anticipate every dangerous one, including those a
future release adds, and fails open on the rest. This fails closed on everything
that is not one of three known commands.

That is also why the cookie file below is named by an environment variable on
this host rather than sent by the caller. `--cookies` stays refused from the
network; the service adds its own, to a command it built itself.

Also enforced: a constant-time bearer check, `https` only, a host allowlist
covering the five platforms (which also refuses `169.254.169.254`), a clamp on
`--playlist-end`, an output cap, and a kill on timeout.

**The token is the whole boundary.** Anyone holding it can make this host fetch
from YouTube and TikTok as fast as it will go. Treat it like the API keys it
sits beside.

## The thing that will actually bite

**YouTube blocks datacentre IPs**, and it blocks ordinary ones too once they
have asked a few times in a row. A walk that works from a laptop starts
returning `Sign in to confirm you're not a bot`. That is a property of where
this runs, not of this code.

Measured 2026-09-08 from a residential Windows machine: the `--flat-playlist`
listing kept working while **every** media resolve was refused, including a
video that had resolved minutes earlier, and no `player_client` made a
difference (`web_embedded`, `tv`, `tv_simply`, `android_vr`, `ios`, `mweb` all
gave the same sentence). So the block lands on the player endpoint first: a run
can file shorts it cannot then hand you a file for.

The service returns yt-dlp's own stderr on failure, and the app surfaces it —
on the run AND on a download — so that line reaches the screen instead of being
flattened into "this channel posted nothing" or "no file for this post".

### Cookies (wired)

Set `YTDLP_COOKIES_FILE` on the service to a Netscape-format `cookies.txt`
exported from a browser signed in to YouTube. Every fetching command then gets
`--cookies <that path>` prepended, after the argv has been rebuilt.

```
docker run -v /srv/ytdlp/cookies.txt:/run/secrets/cookies.txt:ro \
           -e YTDLP_COOKIES_FILE=/run/secrets/cookies.txt ...
```

Four things about that, all of which matter:

- **The path is the server's.** A caller still cannot send `--cookies` — the
  matcher refuses it and always will, because a token holder who could name a
  path could read files off this host through yt-dlp's error messages. The
  cookie file is named by whoever deployed the container and by nobody else.
- **Use a throwaway Google account.** The file is a live session. Anyone who
  reads it is signed in as that account, and YouTube suspends accounts it
  catches being used this way.
- **It expires.** When downloads start refusing with the same sentence again,
  export a fresh file. Nothing here renews it.
- **`--version` never gets it**, so the probe that asks "is yt-dlp here" cannot
  fail because of a cookie file.

The app-side equivalents, for a deployment that spawns yt-dlp locally rather
than calling this service, are `YTDLP_COOKIES_FILE` and
`YTDLP_COOKIES_FROM_BROWSER` in `.env.example`. On Windows only the file works:
yt-dlp cannot read Chrome's or Edge's cookie database there (app-bound
encryption / a locked DB), measured the same day.

### A residential proxy (wired)

Set `YTDLP_PROXY` on the service to a whole URL — `http`, `https`, `socks4`,
`socks4a`, `socks5` or `socks5h`. Every fetching command dials through it;
`--version` does not, so a proxy that is down cannot read as a missing yt-dlp.
Like the cookie file, the caller cannot name it: `--proxy` stays refused from
the network.

**This is the only lever here that needs no account and no human step.** A
cookie jar is a session somebody had to create by signing in; YouTube killed the
OAuth device-code flow, so there is no way left to mint one unattended. An
address needs nobody.

**It is cheaper than per-gigabyte pricing makes it sound**, because of what this
container does not do: both commands it runs are metadata — a listing, and a
`--print` that implies `--simulate`. No video crosses the proxy.

The password in the URL is scrubbed out of every error body this service
returns, because the app puts those on a screen.

### PO tokens (not wired, and measured not to be the problem)

Tested 2026-09-08 against a gated IP: yt-dlp **2026.08.19** with
`bgutil-ytdlp-pot-provider` 2.0.0 answering on `127.0.0.1:4416` — registered and
healthy, `bgutil:http-2.0.0 (external)` in the provider list — was refused
identically on `web`, `mweb` and `tv`, the three clients that actually want a
token. The refusal arrives before a token is requested. Enabling a JS runtime
(`--js-runtimes node`) and `--remote-components ejs:github` changed nothing
either.

So a POT provider is not the fix for a blocked address. It is worth reaching for
if a future failure looks like *missing formats* rather than a flat refusal —
the same pair cobalt calls a `YOUTUBE_SESSION_SERVER`.


## Upgrading yt-dlp

The version is pinned in the `Dockerfile` (`ARG YTDLP_VERSION`). YouTube's
extractors break often enough that "which yt-dlp is this" is the first question
of any outage, which is why it is pinned rather than installed fresh at build
time. Bump it deliberately when something breaks, and redeploy.
