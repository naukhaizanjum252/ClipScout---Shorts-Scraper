import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { adapterFor, seedEnvKey } from "../lib/platform/registry";

/**
 * THE DOCUMENTATION IS TESTED LIKE CODE, BECAUSE IT FAILED LIKE CODE.
 *
 * On 2026-09-04 this repo had 31 test files, 746 passing tests, a clean
 * typecheck and a clean build — and a README that documented `pnpm seed`,
 * `scripts/seed.ts` and `lib/ingest/`, none of which existed any more. It
 * documented a channel review queue the pivot deleted. `package.json` still
 * carried a `seed` script pointing at a file that had been removed. Every one
 * of those was green, because nothing in a test suite ever reads the file a
 * human actually pastes from.
 *
 * That is the same failure the rest of this round is about, in the one place
 * nobody thought to look for it: a unit proved in isolation says nothing about
 * whether the thing that USES it still matches. The entry point for
 * documentation is the file itself — README.md, .env.example, the `scripts`
 * block in package.json — so this test reads those three files as written and
 * checks them against the tree that exists.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * It does not run the commands. Running `pnpm latest` reaches YouTube through
 * yt-dlp and the suite is offline by design (vitest.config.mts says so). The
 * commands in the README were run by hand and the README says on which date and
 * with what result; this file checks the cheaper, more perishable half — that
 * every path, script name and environment variable those commands mention is
 * still real.
 *
 * A NAME MISSING FROM .env.example IS THE FAILURE THIS FILE CARES ABOUT MOST.
 * The X adapter reads `X_SEARCH_QUERY`, `X_MAX_POSTS_PER_RUN` and
 * `X_WINDOW_HOURS`, and until this commit .env.example named none of them. An
 * operator with a valid bearer token would have been told X was unavailable
 * with no file anywhere naming the variable that would fix it. .env.example's
 * own header states the rule — "a variable that exists but is not named in this
 * file is a variable somebody finds by grep, or does not find at all" — and this
 * is what makes the rule bite.
 */

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const README = read("README.md");
const ENV_EXAMPLE = read(".env.example");
const PACKAGE = JSON.parse(read("package.json")) as { scripts: Record<string, string> };

// ---------------------------------------------------------------------------
// Reading the source tree for the environment variables it actually reads
// ---------------------------------------------------------------------------

/** Every non-test TypeScript file the application and its tools are made of. */
function sourceFiles(): string[] {
  const roots = ["lib", "app", "scripts", "verify"];
  const out: string[] = ["proxy.ts"];
  const walk = (rel: string) => {
    for (const entry of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      const next = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === "fixtures" || entry.name === "node_modules") continue;
        walk(next);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      if (/\.test\.tsx?$/.test(entry.name)) continue;
      out.push(next);
    }
  };
  for (const r of roots) walk(r);
  return out;
}

/**
 * `NODE_ENV` is the runtime's, not ours. It is set by `next build`, by vitest
 * and by every host on earth, and writing it on a line in .env.example would
 * invite somebody to fill it in — which is the one thing that must not happen to
 * a variable three separate guards read to decide whether they are in
 * production.
 */
const NOT_OURS = new Set(["NODE_ENV"]);

/**
 * Every environment variable name the source reads, however it reads it.
 *
 * THREE SHAPES, BECAUSE THE CODE USES THREE. `env.X_SEARCH_QUERY` is a property
 * access; `readInt(env, "SHORT_MAX_SECONDS")` passes the name as a string to a
 * helper; `lib/credentials/fields.ts` declares names in a table under an
 * `envVar` key. A scan that knew only the first would have found `X_SEARCH_QUERY`
 * and missed `X_MAX_POSTS_PER_RUN`, which is exactly half the bug.
 *
 * Comment lines are skipped, or every name discussed in a header — and this repo
 * discusses a great many — would count as a read.
 */
function environmentNamesRead(): Map<string, string> {
  const found = new Map<string, string>();
  const note = (name: string, where: string) => {
    if (!NOT_OURS.has(name) && !found.has(name)) found.set(name, where);
  };

  for (const rel of sourceFiles()) {
    const lines = read(rel).split(/\r?\n/);
    lines.forEach((line, i) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*")) return;
      const where = `${rel}:${i + 1}`;

      for (const m of line.matchAll(/\bprocess\.env\.([A-Z][A-Z0-9_]*)/g)) note(m[1] as string, where);
      for (const m of line.matchAll(/\benv\.([A-Z][A-Z0-9_]*)/g)) note(m[1] as string, where);
      for (const m of line.matchAll(/\benv\[\s*"([A-Z][A-Z0-9_]*)"\s*\]/g)) note(m[1] as string, where);

      // The string-literal shape only counts on a line that is about the
      // environment. Without that condition every SCREAMING_SNAKE constant in
      // the repo would be demanded of .env.example.
      if (/env/i.test(line)) {
        for (const m of line.matchAll(/"([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)"/g)) note(m[1] as string, where);
      }
    });
  }
  return found;
}

describe(".env.example names every variable the code reads", () => {
  it("has a line or a paragraph for each one", () => {
    const missing: string[] = [];
    for (const [name, where] of environmentNamesRead()) {
      if (!ENV_EXAMPLE.includes(name)) missing.push(`${name} (read at ${where})`);
    }
    expect(
      missing,
      "read by the code and absent from .env.example — an operator cannot configure what nothing names",
    ).toEqual([]);
  });

  it("does not name PLATFORM_SEEDS_X, because nothing reads it", async () => {
    // X is SEARCHED, not enumerated: lib/platform/registry.ts takes a query, a
    // spend cap and a window for it and never calls seedsFor("x"). A seed
    // variable in the example file is therefore a variable an operator can fill
    // in, redeploy for, and watch change nothing — with money on the line,
    // because the reason X is unavailable is a missing token and this would send
    // them looking somewhere else.
    //
    // Asserted behaviourally rather than by grepping the registry, because the
    // claim being made in .env.example is about EFFECT: setting it changes
    // nothing about what X does.
    const withoutSeeds = await adapterFor("x", { env: {} });
    const withSeeds = await adapterFor("x", { env: { [seedEnvKey("x")]: "@someone, @another" } });
    expect(withSeeds.describe()).toBe(withoutSeeds.describe());
    expect(await withSeeds.unavailableReason()).toBe(await withoutSeeds.unavailableReason());
    expect(ENV_EXAMPLE).not.toContain("PLATFORM_SEEDS_X=");
  });
});

// ---------------------------------------------------------------------------
// Paths and commands, as written for a human to paste
// ---------------------------------------------------------------------------

const PATH_PATTERN = /\b(?:lib|app|scripts|tests|verify|supabase)\/[A-Za-z0-9_\-./()]*[A-Za-z0-9_\-/)]/g;

/**
 * Repo-relative paths a document names.
 *
 * Trailing punctuation is stripped by balancing parentheses, so
 * `app/(admin)/admin/shorts/page.tsx` survives intact while
 * `(see lib/config.ts)` does not keep its closing bracket. Anything followed by
 * a glob character is skipped: a document is allowed to say `*.sql`, and this
 * check is about paths that claim to be one file.
 */
function pathsNamedIn(document: string): string[] {
  const out = new Set<string>();
  for (const m of document.matchAll(PATH_PATTERN)) {
    const after = document[(m.index ?? 0) + m[0].length] ?? "";
    if (after === "*" || after === "{" || after === "[") continue;
    let token = m[0];
    while (token.endsWith(")") && (token.match(/\)/g)?.length ?? 0) > (token.match(/\(/g)?.length ?? 0)) {
      token = token.slice(0, -1);
    }
    out.add(token);
  }
  return [...out];
}

/**
 * The paths and script names a document is allowed to name BECAUSE THEY ARE
 * GONE, or because their absence is itself the finding.
 *
 * AN ALLOWLIST THAT CLEANS ITSELF. Each entry is asserted to be absent as well
 * as excused, so an excuse cannot outlive the thing it excused: the day
 * somebody records a quota measurement, or resurrects a seed script, the entry
 * here goes red and has to be removed rather than quietly protecting a path
 * that now exists and could have been checked. Without that inversion this list
 * is just a place to hide a broken reference, which is the failure the file is
 * about.
 */
const DELIBERATELY_ABSENT: Record<string, string> = {
  // The README's whole "the quota measurement is OUTSTANDING" section is about
  // this file not being there. Nothing has been measured, and no number written
  // into it would change that.
  "verify/fixtures/quota.json": "named precisely because nothing has measured it",
  // The README opens by recording what the pivot deleted and what this file
  // therefore had to stop claiming. Naming the two dead paths is the record;
  // silently dropping them would leave the previous README's readers with no
  // explanation of where `pnpm seed` went.
  "scripts/seed.ts": "deleted by the 2026-09-02 pivot; named in the README's own correction note",
  "lib/ingest/": "deleted by the 2026-09-02 pivot; named in the README's own correction note",
  // .env.example's "Development-only switches" block records that SHORTS_PREVIEW
  // and the module that read it were removed together when the auth gate went.
  // Naming the module is how somebody who still has the variable set in a shell
  // finds out that nothing reads it any more.
  "lib/shorts/preview.ts": "deleted 2026-09-04 with the auth gate it bypassed; named where the variable was documented",
};

const RETIRED_SCRIPTS: Record<string, string> = {
  // The README records that `pnpm seed` and its script were removed by the
  // pivot. Naming the retired command is how a reader with an old shell history
  // finds out what happened to it.
  seed: "removed 2026-09-04 with scripts/seed.ts and the channel inventory",
};

const missingPaths = (document: string) =>
  pathsNamedIn(document)
    .filter((p) => !(p in DELIBERATELY_ABSENT))
    .filter((p) => !fs.existsSync(path.join(ROOT, p)));

describe("the excuses for absent things are still true", () => {
  it("nothing on the deliberately-absent list has come back", () => {
    const resurrected = Object.keys(DELIBERATELY_ABSENT).filter((p) => fs.existsSync(path.join(ROOT, p)));
    expect(resurrected, "excused as absent and now present — check it, do not excuse it").toEqual([]);
  });

  it("no retired script has come back under its old name", () => {
    const back = Object.keys(RETIRED_SCRIPTS).filter((s) => s in PACKAGE.scripts);
    expect(back, "documented as retired and present in package.json").toEqual([]);
  });
});

describe("every file the documentation points at exists", () => {
  it("README.md", () => {
    // SCAR. The README named `scripts/seed.ts`, `lib/ingest/` and
    // `lib/inventory/` for two days after the pivot deleted all three. The
    // "Try it right now" section told a reader to paste a command whose script
    // was not in the tree. Nothing went red, because nothing read the README.
    expect(missingPaths(README), "named in README.md and not in the tree").toEqual([]);
  });

  it(".env.example", () => {
    expect(missingPaths(ENV_EXAMPLE), "named in .env.example and not in the tree").toEqual([]);
  });
});

/**
 * Only the parts of a document a reader would paste: fenced blocks and inline
 * code spans.
 *
 * SCAR. The first version of the check below read the whole README and flagged
 * `pnpm from`, out of the sentence "Next.js 16 is detected from `package.json`,
 * pnpm from `pnpm-lock.yaml`". Prose is allowed to mention pnpm; a command is a
 * thing in backticks, and that distinction is what keeps this check strict
 * enough to be worth having.
 */
function codeIn(document: string): string {
  const fenced = [...document.matchAll(/```[\s\S]*?```/g)].map((m) => m[0]);
  const inline = [...document.matchAll(/`[^`\n]+`/g)].map((m) => m[0]);
  return [...fenced, ...inline].join("\n");
}

describe("every pnpm script the documentation tells you to run exists", () => {
  /** `exec`, `install` and friends are pnpm's own verbs, not this repo's. */
  const PNPM_OWN = new Set(["exec", "install", "dlx", "add", "run", "why", "up", "store"]);

  it("README.md", () => {
    // SCAR. `pnpm seed` was in the README and `"seed": "tsx scripts/seed.ts"`
    // was in package.json, and the file it pointed at had been deleted. Both
    // halves were wrong and each one made the other look right.
    const named = new Set<string>();
    for (const m of codeIn(README).matchAll(/\bpnpm\s+([a-z][a-z0-9:-]*)/g)) {
      const script = m[1] as string;
      if (!PNPM_OWN.has(script) && !(script in RETIRED_SCRIPTS)) named.add(script);
    }
    const unknown = [...named].filter((s) => !(s in PACKAGE.scripts));
    expect(unknown, "run in README.md and not a script in package.json").toEqual([]);
  });

  it("package.json's own scripts point at files that are still here", () => {
    const broken: string[] = [];
    for (const [name, command] of Object.entries(PACKAGE.scripts)) {
      for (const m of command.matchAll(/\b(?:tsx|node)\s+([A-Za-z0-9_\-./]+\.[a-z]+)/g)) {
        if (!fs.existsSync(path.join(ROOT, m[1] as string))) broken.push(`${name} -> ${m[1]}`);
      }
    }
    expect(broken, "a package.json script pointing at a file that does not exist").toEqual([]);
  });
});
