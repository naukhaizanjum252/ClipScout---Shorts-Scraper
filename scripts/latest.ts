/**
 * "Get latest shorts", from the command line.
 *
 *   pnpm exec tsx scripts/latest.ts
 *   pnpm exec tsx scripts/latest.ts --min-views 1000000 --limit 60
 *   pnpm exec tsx scripts/latest.ts --platform youtube --download
 *   pnpm exec tsx scripts/latest.ts --json > run.json
 *
 * WHY IT EXISTS. Erik judges rendered output, not plans, and no Supabase
 * project has been handed over — so the one action the product has needs a way
 * to be run and shown TODAY, with no database, no key and no `.env` file. This
 * runs the real `getLatestShorts` with the real adapters into
 * `MemoryShortsStore` and prints what would have been stored. The moment a
 * project exists, the same call takes a `SupabaseShortsStore` and nothing else
 * changes.
 *
 * IT REPLACES scripts/seed.ts, which drove the channel inventory this repo no
 * longer builds — a review queue with approve/unlist was a misread of the
 * brief and has been deleted rather than deprecated.
 *
 * WHAT IT PRINTS AND WHY THE EMPTY GROUPS ARE THE INTERESTING PART
 *
 * Three of the five platforms cannot be read at all as of 2026-09-04, so most
 * of the output on most runs is going to be empty groups. This prints WHY each
 * one is empty, in the adapter's own words, because "could not be read" and "no
 * shorts over the threshold" are different facts and a list that showed both as
 * a blank space would be telling the client that Instagram has no viral
 * content.
 *
 * DOWNLOAD URLS ARE RESOLVED ONLY IF ASKED, AND NEVER STORED. `--download`
 * resolves one per platform, on demand, to demonstrate the seam. A direct media
 * URL is signed and expires in minutes to hours; the canonical post URL beside
 * every row is the address that survives.
 */
import { minViews, shortMaxSeconds } from "../lib/config";
import { EnvCredentialStore } from "../lib/credentials/env-store";
import type { PlatformAdapter } from "../lib/platform/adapter";
import { buildAdapters } from "../lib/platform/registry";
import { isPlatform, platformLabel, type Platform, type ShortRecord } from "../lib/platform/types";
import { MemoryShortsStore } from "../lib/shorts/memory-store";
import {
  forecastLatestShortsSpend,
  getLatestShorts,
  ran,
  summariseRun,
  type LatestShortsReport,
  type PlatformOutcome,
  type SpendForecastReport,
  type UnverifiedShort,
} from "../lib/shorts/run";

/** Default scan depth per source. A ceiling on cost, not a target. */
const DEFAULT_LIMIT = 60;

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function flag(argv: readonly string[], name: string): string | null {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? (argv[i + 1] ?? null) : null;
}

function positiveInt(raw: string | null, fallback: number, name: string): number {
  if (raw === null) return fallback;
  if (!/^\d+$/.test(raw.trim())) throw new Error(`${name} expects a whole number, got ${JSON.stringify(raw)}.`);
  const n = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new Error(`${name} expects a positive whole number, got ${JSON.stringify(raw)}.`);
  }
  return n;
}

// ---------------------------------------------------------------------------
// Which adapters to run
// ---------------------------------------------------------------------------

/**
 * Every adapter, built the way the application builds them.
 *
 * An adapter whose seeds are empty is STILL CONSTRUCTED AND STILL RUN. It will
 * report itself unavailable with its own explanation of what to seed, which is
 * exactly what an operator needs to read. Leaving it out would replace that
 * explanation with silence.
 *
 * WHERE THE KEYS COME FROM, AND WHY IT IS THE ENVIRONMENT AND ONLY THE
 * ENVIRONMENT. `resolveCredentialStore()` picks the database whenever Supabase
 * is configured, and the database store reads the session cookie through
 * `next/headers` — which does not exist in a `tsx` process. A command line has
 * no session, so the keys it can use are the ones exported into the shell by
 * whoever is sitting at the machine, and `EnvCredentialStore` says so on every
 * lease it hands out (`origin: "environment"`). That is a deliberate limit
 * rather than a gap: an operator's key, held encrypted for their session, is
 * not something a script run by somebody else should be able to spend.
 *
 * SEEDS COME FROM `PLATFORM_SEEDS_*` FOR THE SAME REASON — no `seedStore` is
 * passed, so the registry falls back to the environment. A CLI run therefore
 * does not see seeds added on /admin/seeds, and prints what it did see.
 */
async function configuredAdapters(
  env: NodeJS.ProcessEnv,
  only: Platform | null,
): Promise<PlatformAdapter[]> {
  // SCAR. This used to construct YouTube and TikTok by hand, which contradicted
  // the paragraph directly above it: the three platforms that CANNOT currently
  // run were the three left out, so the one place an operator would have read
  // why Instagram, X and Facebook returned nothing printed nothing about them
  // at all. Silence where an explanation belongs is the failure this repo cares
  // about most, and a hand-written list is how it happens — add a platform to
  // the vocabulary and this file would never mention it.
  //
  // registry.ts is the ONE place that knows which platforms exist, and
  // lib/platform/registry.test.ts fails the build if any module outside
  // lib/platform builds its own adapters. That test is what caught this.
  //
  // SECOND SCAR, 2026-09-04, and it is the same shape one level down: this
  // called `buildAdapters({ env })` and passed NO CREDENTIAL STORE, so X and
  // both Meta adapters reported "no credential is configured" on a machine
  // whose `.env.local` held the token. The registry builds the clients; it can
  // only do that from a store somebody hands it.
  const adapters = [...(await buildAdapters({ env, credentials: new EnvCredentialStore(env) })).values()];
  return only ? adapters.filter((a) => a.platform === only) : adapters;
}

// ---------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------

const n = (value: number) => value.toLocaleString("en");

/**
 * Money, from the integer millionths of a dollar a report carries.
 *
 * Four decimal places, because X's published rate is half a cent per post read
 * and two places would print a real charge as $0.00. A currency renderer that
 * rounds money to nothing is the same mistake as a null view count rendered as
 * a zero, and it is the harder one to notice.
 */
const usd = (micros: number) => {
  const dollars = micros / 1_000_000;
  if (micros > 0 && dollars < 0.0001) return "under $0.0001";
  return dollars.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
};

function describeRow(short: ShortRecord): string {
  const views = short.view_count === null ? "?" : n(short.view_count);
  const seconds = short.duration_seconds === null ? "?" : `${short.duration_seconds}s`;
  const who = short.creator_handle ?? short.creator_id ?? "unknown creator";
  const title = short.title ?? "(untitled)";
  return `  ${views.padStart(12)}  ${seconds.padStart(5)}  ${who.padEnd(24)}  ${title}\n              ${short.url}`;
}

/**
 * The block for the rows a run could not judge.
 *
 * Printed under its own heading, never interleaved with the kept rows. X may
 * not populate a view count for third-party media and Instagram's official API
 * publishes no duration at all, so a row can now arrive having failed nothing
 * and passed less than everything. Mixing those into the list above would put a
 * row nobody measured in the same column as one that really cleared 500,000.
 */
function describeUnverified(entries: readonly UnverifiedShort[]): string {
  const head = `  COULD NOT BE JUDGED — ${n(entries.length)} row(s). Not counted, not stored.`;
  const rows = entries.map((entry) => {
    const missing = entry.unproven.join(" and ");
    return `${describeRow(entry.short)}\n              no ${missing} reported`;
  });
  return [head, ...rows].join("\n");
}

/**
 * One platform's block.
 *
 * Every branch prints something. A branch that printed nothing would put five
 * different facts — read it and found nothing, read part of it, could not read
 * it, it broke, nothing was configured — behind the same blank space.
 */
function describeOutcome(outcome: PlatformOutcome, unverified: readonly UnverifiedShort[]): string {
  const heading = platformLabel(outcome.platform);
  switch (outcome.status) {
    case "ok":
    case "partial": {
      const capped =
        outcome.status === "partial"
          ? ` — STOPPED EARLY (${outcome.truncation.cause}): ${outcome.truncation.message}`
          : "";
      const head =
        `${heading} — ${n(outcome.kept)} kept of ${n(outcome.returned)} read` +
        (outcome.duplicates > 0 ? `, ${n(outcome.duplicates)} already seen this run` : "") +
        capped;
      const dropped =
        `  dropped: ${outcome.dropped.belowThreshold} under the threshold, ` +
        `${outcome.dropped.tooLong} too long, ${outcome.dropped.unknownDuration} with no duration, ` +
        `${outcome.dropped.unknownViews} with no view count, ${outcome.dropped.wrongPlatform} mislabelled`;
      const rows =
        outcome.kept === 0
          ? outcome.status === "partial"
            ? "  Nothing over the threshold in the part that was read. This is NOT an answer about the platform."
            : "  Nothing over the threshold. The platform WAS read — this is an answer about it."
          : outcome.shorts.map(describeRow).join("\n");
      const unjudged = unverified.length === 0 ? [] : [describeUnverified(unverified)];
      return [head, dropped, rows, ...unjudged].join("\n");
    }
    case "unavailable":
      return `${heading} — NOT READ.\n  ${outcome.reason}`;
    case "failed":
      return `${heading} — FAILED.\n  ${outcome.error}`;
    case "no-adapter":
      return `${heading} — NO ADAPTER.\n  ${outcome.reason}`;
    // The CLI asks for every platform it has an adapter for, so this branch is
    // unreachable from here today. It is spelled out rather than folded into
    // NO ADAPTER because the switch is exhaustive over the union, and the day
    // this script grows a `--platforms` flag the two must already print
    // differently.
    case "not-asked":
      return `${heading} — NOT ASKED FOR.\n  ${outcome.reason}`;
  }
}

/**
 * What a run would cost, printed before anybody spends anything.
 *
 * All five platforms, always, and the three kinds are kept apart: a figure, a
 * platform that will run and cannot be priced, and a platform that will not run
 * at all. The middle one is the only one worth worrying about and it would
 * disappear into "no estimate" if the three were collapsed.
 */
function describeForecast(forecast: SpendForecastReport): string {
  const lines = forecast.platforms.map((entry) => {
    const label = platformLabel(entry.platform).padEnd(10);
    if (entry.kind === "priced" && entry.usdMicros !== null) {
      return `  ${label} ${usd(entry.usdMicros).padStart(12)}  ${entry.note}`;
    }
    const state = entry.kind === "unpriced" ? "will run, unpriced" : "will not run";
    return `  ${label} ${"—".padStart(12)}  ${state}. ${entry.note}`;
  });

  // SCAR, found by running this: with nothing configured, `unpriced` is zero and
  // the sum is zero, and the total line printed "$0.00" — a price for a run that
  // would read nothing at all. Vacuously true, and read by a person as "free".
  const nothingRuns = forecast.platforms.every((entry) => entry.kind === "not-running");

  const total = nothingRuns
    ? "  NOTHING WOULD RUN, so there is nothing to price. This is the absence of a run, not a figure of zero."
    : forecast.unpriced === 0
      ? `  TOTAL ${usd(forecast.knownUsdMicros)} — every platform that will run has quoted a figure.`
      : `  FLOOR ${usd(forecast.knownUsdMicros)} — NOT a total: ${forecast.unpriced} platform(s) will ` +
        "run and could not say what that costs. A run may cost more than this and cannot cost less.";

  return [
    `estimated cost of one run at ${n(forecast.minViews)} views, ${n(forecast.limit)} rows per platform:`,
    ...lines,
    total,
  ].join("\n");
}

async function printDownloadUrls(
  report: LatestShortsReport,
  adapters: readonly PlatformAdapter[],
): Promise<void> {
  const byPlatform = new Map(adapters.map((a) => [a.platform, a]));
  process.stderr.write("\ndownload URLs (resolved now, expire within minutes to hours):\n");

  for (const outcome of report.platforms) {
    if (outcome.status !== "ok" || outcome.shorts.length === 0) continue;
    const adapter = byPlatform.get(outcome.platform);
    const top = outcome.shorts[0]!;
    if (!adapter) continue;
    try {
      const url = await adapter.downloadUrl(top);
      process.stderr.write(
        `  ${platformLabel(outcome.platform)}: ${url ?? "no direct media URL available for this post"}\n`,
      );
    } catch (cause) {
      // A failure here says nothing about the row, which was really read and
      // really over the threshold. It is reported beside it, not instead of it.
      process.stderr.write(
        `  ${platformLabel(outcome.platform)}: could not resolve — ${(cause as Error).message}\n`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(argv: readonly string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stderr.write(
      "Usage: tsx scripts/latest.ts [--min-views N] [--limit N] [--platform NAME]\n" +
        "                            [--estimate] [--download] [--json]\n" +
        "\n" +
        "Reads the latest shorts from every configured platform, keeps the ones at or over the\n" +
        "view threshold and at or under the Shorts duration ceiling, and prints one list grouped\n" +
        "by platform, highest views first. Nothing is written to a database — there is not one.\n" +
        "\n" +
        "--estimate prices the run and exits WITHOUT making it. X bills per post returned, so\n" +
        "finding out what a read costs has to be possible without paying for the read.\n" +
        "\n" +
        "Rows the run could not judge — no view count, or no duration — are printed under their\n" +
        "own heading. They are not in the list, not counted and not stored.\n" +
        "\n" +
        "Seed the platforms that need it: PLATFORM_SEEDS_YOUTUBE, PLATFORM_SEEDS_TIKTOK.\n" +
        "\n" +
        "Keys come from THIS SHELL, never from the settings page — a command line has no\n" +
        "session. X needs X_API_KEY, X_SEARCH_QUERY and X_MAX_POSTS_PER_RUN, and that last\n" +
        "one is the ceiling on what a single run may be billed for, at $0.005 per post.\n" +
        "Meta needs INSTAGRAM_API_KEY / FACEBOOK_API_KEY and the ids beside them.\n",
    );
    return 0;
  }

  const platformRaw = flag(argv, "--platform");
  if (platformRaw !== null && !isPlatform(platformRaw)) {
    process.stderr.write(`--platform expects one of the five platforms, got ${JSON.stringify(platformRaw)}.\n`);
    return 2;
  }
  const only: Platform | null = platformRaw === null ? null : platformRaw;

  const threshold = positiveInt(flag(argv, "--min-views"), minViews(), "--min-views");
  const limit = positiveInt(flag(argv, "--limit"), DEFAULT_LIMIT, "--limit");
  const ceiling = shortMaxSeconds();

  const adapters = await configuredAdapters(process.env, only);
  const store = new MemoryShortsStore();

  process.stderr.write(
    `threshold: ${n(threshold)} views · shorts ceiling: ${ceiling}s · scan depth: ${limit} per source\n` +
      // A live project DOES exist now, so "nothing persists" must not read as
      // "there is nowhere to persist to". This command prints; the browser
      // saves. Saying it the other way round sent a reader looking for a
      // missing database instead of a missing feature.
      `store: in-memory — this command prints rather than saves. /admin/shorts is what writes.\n` +
      // Named every run, because a run that spends money should say whose key
      // it spent. A key saved by an operator through the settings page is NOT
      // reachable from here; see `configuredAdapters`.
      `keys: this machine's environment variables only — a command line has no session\n\n`,
  );

  // --estimate PRICES AND STOPS. It deliberately does not go on to run: a flag
  // that spent money after showing you what it would cost would be useless as a
  // way of deciding whether to spend it.
  if (argv.includes("--estimate")) {
    const forecast = await forecastLatestShortsSpend({
      adapters,
      limit,
      minViews: threshold,
      maxDurationSeconds: ceiling,
    });
    if (argv.includes("--json")) {
      process.stdout.write(`${JSON.stringify(forecast, null, 2)}\n`);
    } else {
      process.stdout.write(`${describeForecast(forecast)}\n`);
    }
    process.stderr.write("\nnothing was read and nothing was charged.\n");
    return 0;
  }

  const report = await getLatestShorts({
    adapters,
    store,
    limit,
    minViews: threshold,
    maxDurationSeconds: ceiling,
  });

  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    const unverified = report.unverified ?? [];
    for (const outcome of report.platforms) {
      if (only !== null && outcome.platform !== only) continue;
      const mine = unverified.filter((entry) => entry.short.platform === outcome.platform);
      process.stdout.write(`${describeOutcome(outcome, mine)}\n\n`);
    }
  }

  if (argv.includes("--download")) await printDownloadUrls(report, adapters);

  process.stderr.write(`\n${summariseRun(report)}\n`);

  // WHAT IT COST, EVERY TIME, WHETHER OR NOT ANYBODY ASKED. A platform absent
  // from this list quoted no price, which is not the same as having been free —
  // so the line says which platforms are behind the figure rather than printing
  // a total that looks complete.
  const spend = report.spend ?? [];
  if (spend.length === 0) {
    process.stderr.write(
      "cost: no platform in this run reported a price. That is not a claim it was free.\n",
    );
  } else {
    const total = spend.reduce((sum, row) => sum + row.usdMicros, 0);
    process.stderr.write(
      `cost: ${usd(total)} across ${spend.length} of 5 platforms; the rest quote no price.\n`,
    );
    for (const row of spend) {
      process.stderr.write(`  ${platformLabel(row.platform)}: ${usd(row.usdMicros)} — ${row.note}\n`);
    }
  }

  if (report.persistence.status === "failed") {
    process.stderr.write(`persistence failed: ${report.persistence.error}\n`);
  }

  // A run in which NOTHING could be read is a failed run, even though it threw
  // nothing: the operator asked for the latest shorts and got no reading of any
  // platform. A run that read a platform and found nothing over the threshold
  // succeeded — that is an answer, and so is a platform that read part of
  // itself before a spend cap stopped it. `ran()` is the narrowing that keeps
  // those two together; `o.status === "ok"` here would have made a capped X the
  // only platform read and still exited 1.
  const read = report.platforms.filter(ran).length;
  return read === 0 ? 1 : 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (cause) => {
    process.stderr.write(`${String((cause as Error).stack ?? cause)}\n`);
    process.exit(1);
  },
);
