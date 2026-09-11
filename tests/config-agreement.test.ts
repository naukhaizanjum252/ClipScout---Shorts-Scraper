import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { SHORT_MAX_SECONDS_DEFAULT, dailyQuotaUnits, shortMaxSeconds, sourceAdapterName } from "../lib/config";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

describe("the Shorts ceiling agrees between TypeScript and SQL", () => {
  it("matches shorts_scraper.short_max_seconds()", () => {
    // Two definitions of "what is a Short" that disagree produce two different
    // inventories and neither of them looks wrong. This is the assertion that
    // stops that happening quietly.
    const core = read("supabase/migrations/20260901_01_core.sql");
    const literal = /create function shorts_scraper\.short_max_seconds\(\)[\s\S]*?select\s+(\d+)\s*\$\$/i.exec(core);
    expect(literal, "could not find shorts_scraper.short_max_seconds()").not.toBeNull();
    expect(Number(literal?.[1])).toBe(SHORT_MAX_SECONDS_DEFAULT);
  });

  it("is 120, which is the client's own instruction and not an assumption", () => {
    // Luka, Discord #shorts, 2026-09-01, asked for the longest a Short can be:
    // "2 minutes max is length".
    expect(SHORT_MAX_SECONDS_DEFAULT).toBe(120);
    expect(shortMaxSeconds({})).toBe(120);
  });

  it("is config, so it can move when YouTube's ceiling moves again", () => {
    expect(shortMaxSeconds({ SHORT_MAX_SECONDS: "180" })).toBe(180);
    expect(() => shortMaxSeconds({ SHORT_MAX_SECONDS: "two minutes" })).toThrow();
  });
});

/**
 * The numbers people write when they hardcode a YouTube daily allowance: the
 * published 10,000-unit figure and the two neighbours that get typed next to it.
 */
const QUOTA_SHAPED_NUMBER = /\b(10_?000|1_?000_?000|50_?000)\b/;

/**
 * ...and the wording that turns one of those numbers into a claim about a daily
 * allowance rather than an ordinary round number.
 *
 * SCAR, Phase 3 review. The check used to be the number alone. Phase 3 added
 * subscriber bands to lib/inventory/ranking.ts, whose boundaries are ten
 * thousand and one million subscribers, and `pnpm test` started exiting 1 on
 * two lines that had nothing to do with any API allowance. The collision was
 * pure coincidence of round numbers, and it is the failure mode that kills a
 * guard: the obvious repair is to except the offending directory, or to delete
 * the check as noise, and either one silently retires a real Phase 0 rule for
 * good. So the check was narrowed instead of weakened — it still walks every
 * file under lib, app and verify, and now asks for context before it accuses.
 * "still fires on a genuine hardcoded allowance" below is what stops the
 * narrowing quietly becoming a no-op.
 */
const QUOTA_SHAPED_CONTEXT = /quota|allowance|units|daily|per.?day/i;

/**
 * How far above the number the wording may sit. Short on purpose: a real
 * offender labels itself either in its own identifier (`DAILY_QUOTA_UNITS`) or
 * in the line or two directly above it. Widening this to a whole enclosing
 * doc-comment would drag unrelated prose from the top of a file into range and
 * hand back the false positives this narrowing exists to remove.
 */
const CONTEXT_LINES = 3;

interface Offence {
  readonly line: number;
  readonly text: string;
}

/**
 * The guard itself, as a function over source text.
 *
 * Both the walk over the repo and the proofs below call THIS, so the proofs
 * exercise the matcher that does the work rather than a second copy of the
 * regexes that could drift from it.
 *
 * The number must survive comment-stripping — prose about the published figure
 * is exactly what lib/config.ts is supposed to contain, and forbidding it would
 * forbid explaining the rule. The context may be prose, because a comment is
 * one of the two places a hardcoded allowance announces itself.
 */
function quotaConstantOffences(source: string): Offence[] {
  const lines = source.split("\n");
  const offences: Offence[] = [];
  for (const [i, line] of lines.entries()) {
    const stripped = line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "");
    if (!QUOTA_SHAPED_NUMBER.test(stripped)) continue;
    const context = lines.slice(Math.max(0, i - CONTEXT_LINES), i + 1).join("\n");
    if (!QUOTA_SHAPED_CONTEXT.test(context)) continue;
    offences.push({ line: i + 1, text: line.trim() });
  }
  return offences;
}

describe("no hardcoded daily-quota constant outside config", () => {
  it("has no default allowance anywhere — an unmeasured quota figure is null", () => {
    expect(dailyQuotaUnits({})).toBeNull();
    expect(dailyQuotaUnits({ YOUTUBE_DAILY_QUOTA_UNITS: "10000" })).toBe(10_000);
  });

  /**
   * Phase 0 acceptance: "Grep proves no hardcoded daily-quota constant outside
   * config; the number comes from the recording."
   *
   * The grep, as a test. The published default allowance is 10,000 units/day;
   * that number, and the ones people habitually write next to it, must not
   * appear as a constant anywhere. `lib/config.ts` is where the value would
   * live if it were configured, and it deliberately holds no default at all.
   */
  it("does not name a daily allowance in any source file", () => {
    const roots = ["lib", "app", "verify"];
    const offenders: string[] = [];

    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "fixtures" || entry.name === "node_modules") continue;
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue;
        // Tests are allowed to state an arbitrary allowance, because a test that
        // cannot pick a number cannot assert arithmetic. The rule is about
        // production code.
        if (/\.test\.tsx?$/.test(entry.name)) continue;
        const rel = path.relative(ROOT, full);
        for (const o of quotaConstantOffences(fs.readFileSync(full, "utf8"))) {
          offenders.push(`${rel}:${o.line}: ${o.text}`);
        }
      }
    };
    for (const r of roots) walk(path.join(ROOT, r));

    expect(offenders, `daily-quota-shaped constants found:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("still fires on a genuine hardcoded allowance, named in its own identifier", () => {
    // The narrowing above is only safe if the guard still catches the thing it
    // was written for. This is the offender in its commonest form: nobody has to
    // comment it, because the constant says what it is.
    const source = ["export const DAILY_QUOTA_UNITS = 10_000;", ""].join("\n");
    expect(quotaConstantOffences(source)).toEqual([
      { line: 1, text: "export const DAILY_QUOTA_UNITS = 10_000;" },
    ]);
  });

  it("still fires when only the comment above gives it away", () => {
    // The second form: an innocuous name with the claim in the prose over it.
    // Context is read from the raw lines, comments included, precisely so this
    // one cannot hide behind a bland identifier.
    const source = [
      "/** The allowance a fresh Google Cloud project gets in a day. */",
      "const LIMIT = 10000;",
    ].join("\n");
    expect(quotaConstantOffences(source).map((o) => o.line)).toEqual([2]);
  });

  it("does not fire on a round number that is about something else entirely", () => {
    // The regression this narrowing exists for: subscriber-band boundaries in
    // lib/inventory/ranking.ts. If this ever goes red the guard has widened back
    // out and the next unrelated round number will be reported as a quota leak
    // — which is how a real check gets deleted as noise.
    const source = [
      "const SUBSCRIBER_BAND_CEILINGS = [",
      '  { band: "1k-10k", below: 10_000 },',
      '  { band: "100k-1m", below: 1_000_000 },',
      "];",
    ].join("\n");
    expect(quotaConstantOffences(source)).toEqual([]);
  });

  it("lets lib/config.ts keep explaining the rule in prose", () => {
    // The number in a comment is not a hardcoded constant, and the repo's whole
    // position on quota is written down in comments. A guard that forbade
    // discussing the figure would force the explanation out of the code.
    const source = [
      "// The published daily allowance is 10_000 units, and this repo does not",
      "// hold it: the number comes from the operator's own console.",
      "export function dailyQuotaUnits() {}",
    ].join("\n");
    expect(quotaConstantOffences(source)).toEqual([]);
  });
});

describe("the source adapter default", () => {
  it("is the keyless one, so the seeded path runs with no key and no .env at all", () => {
    expect(sourceAdapterName({})).toBe("ytdlp");
    expect(sourceAdapterName({ SOURCE_ADAPTER: "api" })).toBe("api");
    expect(() => sourceAdapterName({ SOURCE_ADAPTER: "scrape" })).toThrow();
  });
});

describe("no credential value is committed anywhere", () => {
  it("keeps .env.example to names only", () => {
    const example = read(".env.example");
    for (const line of example.split("\n")) {
      if (line.trim().startsWith("#") || !line.includes("=")) continue;
      const [, ...rest] = line.split("=");
      expect(rest.join("=").trim(), `${line} carries a value`).toBe("");
    }
  });

  it("keeps .env.local out of git", () => {
    expect(read(".gitignore")).toMatch(/^\.env\*/m);
  });

  it("has no Google-API-key-shaped string in any tracked source or fixture", () => {
    // Real Data API keys are `AIza` + 35 base64url characters. The fake used in
    // the credential tests is deliberately shaped so it cannot match.
    const suspicious = /AIza[0-9A-Za-z_-]{35}/;
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if ([".git", "node_modules", ".next"].includes(entry.name)) continue;
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx|json|sql|md|mjs|css)$/.test(entry.name)) continue;
        if (suspicious.test(fs.readFileSync(full, "utf8"))) offenders.push(path.relative(ROOT, full));
      }
    };
    walk(ROOT);
    expect(offenders).toEqual([]);
  });
});
