import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { CREDENTIAL_PROVIDERS } from "@/lib/credentials/types";
import { PLATFORMS } from "@/lib/platform/types";

/**
 * The migration audit.
 *
 * IT IS STATIC, AND HERE IS WHY THAT IS THE HONEST FORM OF IT. This tool lives
 * in LookUp Media's own Supabase, one shared database, in its own
 * `shorts_scraper` schema (Erik, 2026-09-02) — but no project reference has ever
 * been handed over, so there is no database to introspect and NOT ONE MIGRATION
 * IN THIS DIRECTORY HAS EVER BEEN APPLIED. Standing one up locally is not
 * available either: this account's standing rule is that Docker is never used,
 * and `supabase start` is Docker.
 *
 * So this reads the SQL. That is weaker than querying `pg_proc` and
 * `pg_policies`, and it is weaker in a specific way worth stating: it proves the
 * migrations SAY the right thing, not that a live database IS in that state.
 * What it does catch is the failure mode that actually happened in
 * `impressions` — a function added later without both revokes — because this
 * test fails the moment somebody adds one.
 *
 * THE DYNAMIC HALF EXISTS AND IS RED. `verify/db.ts --check` runs these same
 * claims against `pg_proc`, `pg_policies` and the column-level ACLs on a live
 * database. It has never been pointed at one. This file stays as the pre-commit
 * guard either way, because it fails before a bad migration is ever applied.
 *
 * WHAT THE 2026-09-04 PIVOT DID TO THIS FILE. The schema it audited was a
 * CHANNEL inventory with a review queue, an approve/unlist state machine and
 * per-finding provenance. Erik replaced that product, so the tables, the state
 * machine and the assertions that guarded them are gone — deleted as obsolete,
 * not as inconvenient. Every guard that was a SCAR rather than a feature is
 * still here word for word: the shared-database rules, both-doors EXECUTE, the
 * column-level secret grants, the pinned definer search_path, the explicit
 * table grants, and the comment stripper with its own regression test.
 *
 * The strongest thing here is now the EXACT-SET assertions on tables, types and
 * functions. A single expectation, in one place, that fails the moment the
 * channel product starts growing back one object at a time.
 */

const MIGRATIONS_DIR = path.resolve(import.meta.dirname, "..", "supabase", "migrations");

const files = fs
  .readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();

const sql = files.map((f) => ({ file: f, body: fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf8") }));
const allSql = sql.map((s) => s.body).join("\n");

/**
 * SQL with `--` comments removed, so prose about anon never satisfies a check.
 *
 * THE LINE-ENDING NORMALISATION IS NOT COSMETIC, AND THIS COMMENT IS A SCAR.
 * The first version of this split on "\n" and stripped with `/--.*$/`. The .sql
 * files in this working tree were CRLF, so every line arrived with a trailing
 * "\r" — and in JavaScript "\r" is a LINE TERMINATOR, which `.` does not match,
 * so it sat between `.*` and `$` and the regex matched nothing. NOT ONE COMMENT
 * WAS EVER STRIPPED.
 *
 * That is the worst direction for a security check to be wrong in: a broken
 * stripper makes assertions PASS more easily, never fail. The audit was reading
 * its own prose as though it were SQL, so a migration whose comments merely
 * DISCUSSED revoking from anon would have satisfied the check that anon had
 * actually been revoked. Nothing went red, which is exactly why it survived —
 * it only surfaced when a migration was edited and its new prose tripped an
 * unrelated check.
 *
 * Normalising line endings first is the fix and dropping the `$` is the belt.
 * `.gitattributes` now pins the working tree to LF so it stops recurring, and
 * "the comment stripper actually strips" at the bottom of this file is what
 * fails if any of that is undone.
 */
const code = allSql
  .replace(/\r\n?/g, "\n")
  .split("\n")
  .map((line) => line.replace(/--.*/, ""))
  .join("\n");

function matchAll(re: RegExp, subject = code): string[][] {
  return [...subject.matchAll(re)].map((m) => [...m]);
}

/**
 * The values of one `create type ... as enum (...)`, IN DECLARED ORDER.
 *
 * Order is kept rather than sorted because two of the assertions below compare
 * an enum against a TypeScript list where the order carries meaning — it is the
 * order the credentials page groups by. A helper that sorted would make those
 * comparisons weaker for no reason, and the assertions that only care about
 * membership sort at the call site where that choice is visible.
 *
 * A missing type returns an empty array rather than throwing, so the failure
 * reads as "expected six values, got none" instead of a regex exception with no
 * subject in it.
 */
/**
 * An enum's values as the migrations LEAVE them, `create` plus every later
 * `alter`.
 *
 * IT USED TO READ ONLY THE `create`, and that was fine for exactly as long as
 * no enum was ever extended. Migration 15 adds 'threads' to two of them, and
 * against the old parser both assertions below failed while the schema was
 * correct — the parser was describing the schema as of migration 01 and calling
 * it the schema.
 *
 * POSITION IS HONOURED because these assertions compare order and Postgres
 * honours it: a bare `add value` appends, `before`/`after` inserts. A parser
 * that appended everything would pass a migration that puts a platform on the
 * far side of the vendor and let the two files drift in exactly the way the
 * order comparison exists to prevent.
 */
function enumValues(typeName: string): string[] {
  const found = new RegExp(
    `create\\s+type\\s+shorts_scraper\\.${typeName}\\s+as\\s+enum\\s*\\(([^)]*)\\)`,
    "i",
  ).exec(code);
  if (!found) return [];
  const values = found[1]
    .split(",")
    .map((v) => v.trim().replace(/'/g, ""))
    .filter((v) => v.length > 0);

  const alter = new RegExp(
    `alter\\s+type\\s+shorts_scraper\\.${typeName}\\s+add\\s+value\\s+(?:if\\s+not\\s+exists\\s+)?` +
      `'([^']+)'(?:\\s+(before|after)\\s+'([^']+)')?`,
    "gi",
  );
  for (const [, value, placement, anchor] of code.matchAll(alter)) {
    if (values.includes(value)) continue;
    const at = anchor ? values.indexOf(anchor) : -1;
    if (at === -1) values.push(value);
    else values.splice(placement?.toLowerCase() === "before" ? at : at + 1, 0, value);
  }
  return values;
}

/**
 * The body of one `create table`, parentheses balanced.
 *
 * WHY PARSE INSTEAD OF GREPPING THE WHOLE FILE. Several assertions below are
 * about what a table DOES NOT HAVE — no stored media URL, no regex on an id,
 * no default on the recorded threshold. A substring search over the joined SQL
 * answers those wrongly in both directions: it trips on the word appearing in a
 * `comment on column` string (which the `--` stripper does not remove, because
 * it is a SQL literal and not a comment), and it misses a column whose name
 * says nothing about what it holds. Reading the actual column list is immune to
 * both, and it is what makes the exact-set assertions possible.
 */
function tableBody(name: string): string {
  const open = new RegExp(
    `create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?shorts_scraper\\.${name}\\s*\\(`,
    "i",
  ).exec(code);
  if (!open) return "";
  const from = open.index + open[0].length;
  let depth = 1;
  let i = from;
  while (i < code.length && depth > 0) {
    if (code[i] === "(") depth += 1;
    else if (code[i] === ")") depth -= 1;
    i += 1;
  }
  return code.slice(from, i - 1);
}

/** Top-level comma-separated entries of a table body: columns AND constraints. */
function tableEntries(name: string): string[] {
  const body = tableBody(name);
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of body) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out.map((e) => e.trim()).filter((e) => e.length > 0);
}

const NOT_A_COLUMN = /^(primary|unique|check|foreign|constraint|exclude|like)\b/i;

/** Column names of a table, in declaration order. */
function columnsOf(name: string): string[] {
  return tableEntries(name)
    .filter((e) => !NOT_A_COLUMN.test(e))
    .map((e) => /^\w+/.exec(e)?.[0] ?? "")
    .filter(Boolean);
}

/** The declaration of one column, so an assertion can be about ITS text alone. */
function columnDecl(table: string, column: string): string {
  return tableEntries(table).find((e) => !NOT_A_COLUMN.test(e) && new RegExp(`^${column}\\b`).test(e)) ?? "";
}

const TABLES = matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?shorts_scraper\.(\w+)/gi).map((m) => m[1]);

describe("migration hygiene", () => {
  it("has migrations, named the way impressions names them", () => {
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(f).toMatch(/^\d{8}_\d{2}_[a-z0-9_]+\.sql$/);
  });
});

/**
 * THE SHAPE OF THE PRODUCT, ASSERTED ONCE.
 *
 * Erik replaced the channel-curation product on 2026-09-04 with a single
 * action: read the latest Shorts on every platform, keep the ones over a view
 * threshold and inside the duration ceiling, return one list categorised by
 * platform. These three lists are the whole schema, and they are exact rather
 * than "contains" on purpose — a `toContain` assertion cannot notice
 * `channels`, `channel_sources` or `set_channel_state` reappearing, and that is
 * the specific regression this pivot is at risk of.
 */
describe("the schema is the shorts product and nothing else", () => {
  /**
   * THE LIST GREW ON 2026-09-04 AND EACH ADDITION EARNED ITS PLACE.
   *
   * `platform_seeds`, `platform_schedule` and `seed_proposals` are the seeded
   * intake becoming rows instead of a hand-edited environment variable, so that
   * a run can fire on a clock and so that "why are we fetching this creator" has
   * an answer six weeks later. They are the answer to Erik's TikTok question and
   * they are deliberately NOT a discovery mechanism: a scheduler refreshes a
   * known list, and nothing available to this build can grow one.
   *
   * The assertion stays EXACT rather than becoming a `toContain`. A contains
   * check cannot notice `channels`, `channel_sources` or `set_channel_state`
   * reappearing, and the whole point of pinning the shape is that the abandoned
   * curation product cannot grow back one object at a time.
   */
  it("creates exactly these tables", () => {
    expect([...TABLES].sort()).toEqual([
      "api_credentials",
      "credential_quota_days",
      "platform_schedule",
      "platform_seeds",
      "profiles",
      "run_platforms",
      "run_reports",
      "runs",
      "seed_proposals",
      "shorts",
      "topic_channels",
      "topics",
      "unverified_shorts",
      "used_shorts",
    ]);
  });

  it("creates exactly these types", () => {
    const types = matchAll(/create\s+type\s+shorts_scraper\.(\w+)\s+as\b/gi).map((m) => m[1]);
    expect([...types].sort()).toEqual(["app_role", "credential_provider", "credential_status", "platform"]);
  });

  it("creates exactly these functions", () => {
    const fns = matchAll(/create\s+(?:or\s+replace\s+)?function\s+shorts_scraper\.(\w+)\s*\(/gi).map((m) => m[1]);
    expect([...new Set(fns)].sort()).toEqual([
      "can_read",
      "is_admin",
      "lease_api_credential",
      "record_credential_units",
      // Seeds stopped being a manual task on 2026-09-05. These two compute the
      // rolling seven-day top 200 creators per platform out of the rows runs
      // have already stored, and write them into `platform_seeds` as `source =
      // 'auto'`. Read the 11 migration's header for why a ROLLING ranking is
      // buildable honestly where a fixed "top 200" list would have been
      // invented data.
      "refresh_auto_seeds",
      "role_of",
      // A seed is an ADDRESS, not a display name. Migration 13 added this after
      // the ranking seeded "Cocomelon - Nursery Rhymes" and every platform on
      // /admin/shorts read "will not run"; it maps a stored short to the value
      // that platform's adapter can address, and to null when there is none.
      "seed_from_short",
      "short_max_seconds",
      "top_creators",
    ]);
  });

  it("names all five platforms, because a platform nobody can read yet still has to be nameable", () => {
    // Three of the five have no adapter that can serve them (yt-dlp 2026.07.04:
    // `instagram:user` is marked CURRENTLY BROKEN; x and facebook have no
    // timeline enumerator at all). They are in the enum anyway, because a run
    // has to be able to record that a platform was attempted and could not be
    // read — which is impossible if the value does not exist.
    const platform = /create\s+type\s+shorts_scraper\.platform\s+as\s+enum\s*\(([^)]*)\)/i.exec(code);
    expect(platform, "no shorts_scraper.platform enum").not.toBeNull();
    const values = (platform?.[1] ?? "").split(",").map((v) => v.trim().replace(/'/g, ""));
    expect(values).toEqual(["youtube", "tiktok", "instagram", "x", "facebook"]);
  });

  it("holds exactly the ShortRecord contract, plus the one field the database derives", () => {
    // lib/platform/types.ts is the other half of this list. Two definitions of a
    // Short that disagree is how a column quietly stops being written.
    expect(columnsOf("shorts")).toEqual([
      "platform",
      "platform_video_id",
      "url",
      "title",
      "creator_handle",
      "creator_id",
      "creator_url",
      "duration_seconds",
      "view_count",
      "like_count",
      "comment_count",
      "published_at",
      "thumbnail_url",
      "discovered_at",
      "discovered_by",
      "is_short",
    ]);
  });
});

/**
 * IDENTITY.
 *
 * The old `channels` table checked its primary key against
 * '^UC[A-Za-z0-9_-]{22}$'. That single constraint is what made the previous
 * design single-platform: it is a YouTube fact compiled into the storage layer,
 * and no other platform's ids satisfy it. The pivot's instruction is explicit
 * that the assumption must not come back in another shape, so this describes
 * what the key IS and asserts that nothing pattern-matches it.
 */
describe("identity is (platform, platform_video_id) and nothing pattern-matches an id", () => {
  it("makes the pair the primary key", () => {
    const pk = tableEntries("shorts").find((e) => /^primary\s+key/i.test(e)) ?? "";
    expect(pk.replace(/\s+/g, " ")).toMatch(/^primary key \(\s*platform\s*,\s*platform_video_id\s*\)$/i);
  });

  it("constrains the id for being blank and for nothing else", () => {
    const decl = columnDecl("shorts", "platform_video_id");
    expect(decl).toMatch(/\btext\b/i);
    expect(decl).toMatch(/not\s+null/i);
    // `~` is Postgres' regex match operator. Its presence on this column, in any
    // form, is the assumption returning.
    expect(decl, "platform_video_id must carry no pattern constraint").not.toContain("~");
  });

  it("has no YouTube-shaped pattern left anywhere in the schema", () => {
    /*
     * ONE EXEMPTION, ADDED 2026-09-05, AND IT IS NOT A CONSTRAINT.
     *
     * `seed_from_short` (migration 13) turns a stored short into the value that
     * platform's adapter can address, and YouTube's is `UC` plus 22 characters.
     * That is the opposite of the thing this rule forbids: the old `channels`
     * primary key applied ONE platform's id shape to EVERY row, which is what
     * made the schema single-platform. This is a five-way CASE on
     * `shorts_scraper.platform` in which each platform states its own address
     * format, it constrains no column, and it rejects nothing — a row it cannot
     * address is simply not seeded.
     *
     * The exemption is that function and nothing else, which is what the
     * removal-then-assert below actually checks.
     */
    const withoutSeedShapes = code.replace(
      /create\s+or\s+replace\s+function\s+shorts_scraper\.seed_from_short[\s\S]*?\$\$;/i,
      "",
    );
    expect(withoutSeedShapes).not.toMatch(/\^UC\[/i);

    // ANTI-VACUITY, twice over: the pattern must still exist (or the removal
    // above proves nothing), and it must not have taken the rest of the schema
    // with it (a runaway `[\s\S]*?` that swallowed every later migration would
    // make the assertion above pass on anything).
    expect(code).toMatch(/\^UC\[/i);
    expect(withoutSeedShapes).toMatch(/create\s+or\s+replace\s+function\s+shorts_scraper\.refresh_auto_seeds/i);
  });
});

/**
 * THE VIEW THRESHOLD IS A QUERY-TIME FILTER, AND THE SCHEMA MUST NOT LEARN IT.
 *
 * Erik named 500,000 directly, so it has a real default — in lib/config.ts,
 * where config lives. Two separate reasons it is not a generated column here,
 * and the second is the one that matters:
 *
 *   It would freeze one operator's threshold into the schema, so asking a
 *   different question would be a migration and a full table rewrite.
 *
 *   A STORED generated column is computed on write. `duration_seconds` never
 *   changes, so `is_short` is right forever. `view_count` moves — a video
 *   crosses the threshold some time AFTER it was stored — so the boolean would
 *   quietly answer "was this over the bar when we last touched the row" while
 *   reading like "is this over the bar". A wrong answer that looks right.
 */
describe("what a Short is, is decided by the database; whether it is popular is not", () => {
  it("derives is_short in the database rather than trusting whatever wrote the row", () => {
    const decl = columnDecl("shorts", "is_short");
    expect(decl).toMatch(/boolean\s+generated\s+always\s+as/i);
    expect(decl).toMatch(/duration_seconds\s*<=\s*shorts_scraper\.short_max_seconds\(\)/i);
    // Unknown duration is NOT a Short. Without the null test the comparison is
    // null, the column is null, and a `where is_short` filter silently drops
    // rows while a `where not is_short` one silently drops the same rows.
    expect(decl).toMatch(/duration_seconds\s+is\s+not\s+null/i);
  });

  it("has no generated column, and no function, for the view threshold", () => {
    const generated = tableEntries("shorts").filter((e) => /generated\s+always/i.test(e));
    expect(generated.map((e) => /^\w+/.exec(e)?.[0])).toEqual(["is_short"]);
    expect(code).not.toMatch(/min_views\s*\(\s*\)/i);
  });

  it("never writes 500,000 into the schema", () => {
    // The number is Erik's instruction and it belongs in lib/config.ts. In SQL
    // it would be a second copy that no test can see drift in.
    expect(code).not.toMatch(/\b500_?000\b/);
  });

  it("records the threshold that was applied on the run instead, with no default", () => {
    // This is what makes the dropped counts readable later. A default here would
    // let a row claim a threshold nobody applied.
    const decl = columnDecl("runs", "min_views");
    expect(decl, "runs.min_views is missing").not.toBe("");
    expect(decl).toMatch(/not\s+null/i);
    expect(decl, "a default would be a third copy of the threshold").not.toMatch(/\bdefault\b/i);
  });
});

/**
 * THE HONESTY RULE, AS A SCHEMA FACT.
 *
 * "No results" and "this platform could not be read" must never look the same.
 * On screen that is rendering; after the fact it is storage, because a list
 * with nothing under `instagram` is indistinguishable from a list where
 * Instagram was never reached unless something wrote down what happened.
 *
 * Three states, distinguishable by looking: no row (not attempted), a row with
 * a reason (attempted, could not be read), a row without one (read; `kept = 0`
 * genuinely means nothing cleared the bar).
 */
describe("a run can tell 'found nothing' apart from 'could not read it'", () => {
  it("keeps one row per platform attempted, keyed by the run and the platform", () => {
    const pk = tableEntries("run_platforms").find((e) => /^primary\s+key/i.test(e)) ?? "";
    expect(pk.replace(/\s+/g, " ")).toMatch(/^primary key \(\s*run_id\s*,\s*platform\s*\)$/i);
  });

  it("carries a reason that is nullable, and never blank when present", () => {
    const decl = columnDecl("run_platforms", "unavailable_reason");
    expect(decl, "run_platforms.unavailable_reason is missing").not.toBe("");
    expect(decl, "null is what 'the adapter ran' looks like").not.toMatch(/not\s+null/i);
    // "Unavailable" with no reason is the answer that sends somebody digging
    // through logs. The adapter contract says to name what is missing; this is
    // the database refusing the row that does not.
    expect(decl).toMatch(/btrim\s*\(\s*unavailable_reason\s*\)\s*<>\s*''/i);
  });

  it("refuses a row that claims to be unavailable AND to have counted something", () => {
    const constraint = /constraint\s+an_unavailable_platform_counts_nothing\s+check\s*\(([\s\S]*?)\)\s*,/i.exec(
      tableBody("run_platforms"),
    );
    expect(constraint, "nothing stops an unavailable platform reporting counts").not.toBeNull();
    const body = constraint?.[1] ?? "";
    for (const counter of ["rows_returned", "kept", "dropped_below_min_views", "dropped_over_duration"]) {
      expect(body, `${counter} must be forced to zero when the platform was unavailable`).toContain(counter);
    }
  });

  it("makes the counts add up, so a miscount fails the insert instead of rendering", () => {
    const body = tableBody("run_platforms");
    expect(body).toMatch(
      /constraint\s+every_returned_row_is_accounted_for\s+check\s*\(\s*rows_returned\s*=\s*kept\s*\+\s*dropped_below_min_views\s*\+\s*dropped_over_duration\s*\)/i,
    );
  });

  it("stops a keyless run from claiming it spent quota", () => {
    // Survives the pivot verbatim in meaning: spend belongs to a key, and the
    // default path (yt-dlp) has none. Only the table it lives on changed.
    expect(tableBody("run_platforms")).toMatch(/constraint\s+spend_needs_a_credential/i);
  });

  it("lets nobody delete the record — an erasable record is not evidence", () => {
    for (const table of ["runs", "run_platforms"]) {
      expect(code, `a DELETE policy on ${table} would let a session erase the difference`).not.toMatch(
        new RegExp(`create\\s+policy\\s+"[^"]*"\\s+on\\s+shorts_scraper\\.${table}\\s+for\\s+delete`, "i"),
      );
      expect(code, `a DELETE grant on ${table}`).not.toMatch(
        new RegExp(`grant\\s+[a-z,\\s]*\\bdelete\\b[a-z,\\s]*\\s+on\\s+shorts_scraper\\.${table}\\s+to`, "i"),
      );
    }
  });
});

/**
 * NO EXPIRING URL IS EVER STORED.
 *
 * The product hands the operator a way to fetch the video, and the adapter
 * resolves that on demand. A direct media URL from any of these platforms is
 * signed and expires in minutes to hours, so a column of them is a table full
 * of dead links that LOOK alive — the same failure shape as a stale generated
 * threshold, and worse, because a dead link is only discovered by the person
 * who needed it.
 *
 * The column list of `shorts` above already pins this. This asserts it over
 * every table, so a `media_cache` table cannot arrive beside it.
 */
describe("nothing in the schema stores a resolved media address", () => {
  it("has no column anywhere shaped like stored media", () => {
    const offenders: string[] = [];
    for (const table of TABLES) {
      for (const column of columnsOf(table)) {
        if (/download|media|video_url|file|storage|blob|stream|asset/i.test(column)) {
          offenders.push(`${table}.${column}`);
        }
      }
    }
    expect(offenders, "a resolved media URL expires; the post URL is what persists").toEqual([]);
  });

  it("keeps the canonical post URL instead, and requires it", () => {
    const decl = columnDecl("shorts", "url");
    expect(decl).toMatch(/not\s+null/i);
  });
});

describe("anon has no RLS policy", () => {
  const policies = matchAll(/create\s+policy\s+"([^"]+)"\s+on\s+([a-z_.]+)\s+for\s+(\w+)\s+to\s+([a-z_,\s]+?)\s+(?:using|with)\b/gis);

  it("finds every policy, and every one of them names its roles", () => {
    // A policy with no `to` clause applies to PUBLIC, which INCLUDES anon. The
    // count check is what stops a role-less policy slipping past the regex above
    // by simply not matching it.
    const declared = matchAll(/create\s+policy\s/gi).length;
    expect(policies.length).toBe(declared);
    expect(declared).toBeGreaterThan(0);
  });

  it("grants no policy to anon or to public", () => {
    for (const [, name, , , roles] of policies) {
      const list = roles.split(",").map((r) => r.trim().toLowerCase());
      expect(list, `policy ${name}`).not.toContain("anon");
      expect(list, `policy ${name}`).not.toContain("public");
      expect(list.length, `policy ${name}`).toBeGreaterThan(0);
    }
  });

  it("enables RLS on every table it creates", () => {
    expect(TABLES.length).toBeGreaterThan(0);
    for (const table of TABLES) {
      expect(code, `RLS on shorts_scraper.${table}`).toMatch(
        new RegExp(`alter\\s+table\\s+shorts_scraper\\.${table}\\s+enable\\s+row\\s+level\\s+security`, "i"),
      );
    }
  });
});

describe("anon has EXECUTE on no function", () => {
  const created = matchAll(/create\s+(?:or\s+replace\s+)?function\s+shorts_scraper\.(\w+)\s*\(/gi).map((m) => m[1]);

  /**
   * BOTH DOORS. This is the `impressions` lesson, mechanised.
   *
   * Postgres grants EXECUTE on every new function to PUBLIC. Supabase then adds
   * an explicit `anon` grant on top. `revoke ... from public` leaves the second;
   * `revoke ... from anon` leaves the first. An audit in `impressions` found
   * twelve of fifteen functions anon-callable for exactly this reason.
   */
  it("revokes EXECUTE from BOTH public AND anon on every function created", () => {
    expect(created.length).toBeGreaterThan(0);
    for (const fn of new Set(created)) {
      const revoke = new RegExp(
        `revoke\\s+execute\\s+on\\s+function\\s+shorts_scraper\\.${fn}\\s*\\([^)]*\\)\\s*from\\s+([a-z_,\\s]+);`,
        "i",
      );
      const m = revoke.exec(code);
      expect(m, `no revoke for shorts_scraper.${fn}()`).not.toBeNull();
      const roles = (m?.[1] ?? "").split(",").map((r) => r.trim().toLowerCase());
      expect(roles, `shorts_scraper.${fn}(): revoke must name public`).toContain("public");
      expect(roles, `shorts_scraper.${fn}(): revoke must name anon`).toContain("anon");
    }
  });

  it("never grants EXECUTE back to anon", () => {
    const grants = matchAll(/grant\s+execute\s+on\s+function\s+shorts_scraper\.(\w+)[^;]*?to\s+([a-z_,\s]+);/gi);
    for (const [, fn, roles] of grants) {
      const list = roles.split(",").map((r) => r.trim().toLowerCase());
      expect(list, `grant on shorts_scraper.${fn}()`).not.toContain("anon");
      expect(list, `grant on shorts_scraper.${fn}()`).not.toContain("public");
    }
  });

  it("turns off the default privileges that caused the problem, for both roles", () => {
    expect(code).toMatch(
      /alter\s+default\s+privileges\s+in\s+schema\s+shorts_scraper\s+revoke\s+execute\s+on\s+functions\s+from\s+public/i,
    );
    expect(code).toMatch(
      /alter\s+default\s+privileges\s+in\s+schema\s+shorts_scraper\s+revoke\s+execute\s+on\s+functions\s+from\s+anon/i,
    );
  });

  it("revokes table and sequence privileges from anon as well", () => {
    expect(code).toMatch(/revoke\s+all\s+on\s+all\s+tables\s+in\s+schema\s+shorts_scraper\s+from\s+anon/i);
    expect(code).toMatch(/alter\s+default\s+privileges\s+in\s+schema\s+shorts_scraper\s+revoke\s+all\s+on\s+tables\s+from\s+anon/i);
  });
});

describe("the secret column is unreachable by a browser session", () => {
  it("revokes table-wide SELECT on api_credentials and grants back column by column", () => {
    expect(code).toMatch(/revoke\s+select\s+on\s+shorts_scraper\.api_credentials\s+from\s+authenticated/i);
    const grant = /grant\s+select\s*\(([^)]*)\)\s*on\s+shorts_scraper\.api_credentials\s+to\s+authenticated/i.exec(code);
    expect(grant, "no column-level SELECT grant on api_credentials").not.toBeNull();
    const columns = (grant?.[1] ?? "").split(",").map((c) => c.trim());
    expect(columns).toContain("masked");
    // The whole point.
    expect(columns).not.toContain("secret_ciphertext");
  });

  /**
   * EVERY COLUMN IS EITHER READABLE OR DELIBERATELY NOT, AND THERE IS NO THIRD
   * STATE.
   *
   * This is the assertion the credentials migration's own warning asks for. It
   * says: "a column added to this table later arrives with NO grant and is
   * invisible to `authenticated` until it is named here". That is the safe
   * direction to fail in and it is a SILENT one — the column simply never
   * appears, PostgREST does not complain, and the page renders a blank where a
   * value should be.
   *
   * It bit on 2026-09-04. A credential stopped being one string: Meta needs an
   * app id, an app secret, a token and the account the request is made from, and
   * the non-secret half of that went into a new `identifiers` column. Added to
   * the table and not to the grants, it would have been unreadable by the very
   * screen that exists to show it, with nothing red anywhere.
   *
   * So the rule is forced into the open: every column of `api_credentials` is
   * either granted SELECT to `authenticated` or is on the short list below of
   * columns nobody may ever read. Adding a column now requires choosing, in a
   * file somebody reviews.
   */
  const UNREADABLE_BY_DESIGN = ["secret_ciphertext"];

  it("accounts for every api_credentials column as readable or deliberately not", () => {
    const grant = /grant\s+select\s*\(([^)]*)\)\s*on\s+shorts_scraper\.api_credentials\s+to\s+authenticated/i.exec(code);
    const granted = (grant?.[1] ?? "").split(",").map((c) => c.trim());
    const columns = columnsOf("api_credentials");
    expect(columns.length).toBeGreaterThan(0);

    const unaccounted = columns.filter((c) => !granted.includes(c) && !UNREADABLE_BY_DESIGN.includes(c));
    expect(
      unaccounted,
      "a column that is neither granted nor listed as secret is invisible to the page and nothing says why",
    ).toEqual([]);

    for (const secret of UNREADABLE_BY_DESIGN) {
      expect(granted, `${secret} must never be selectable`).not.toContain(secret);
      expect(columns, `${secret} is not on the table any more`).toContain(secret);
    }
  });

  /**
   * THE NON-SECRET HALF OF A CREDENTIAL IS READABLE ON PURPOSE.
   *
   * `identifiers` holds a Meta app id, a Page id, an Instagram business account
   * id. None of those is a secret — an app id appears in every Meta login
   * dialog — and all of them are exactly what an operator needs to SEE to know
   * they pasted the right app. Encrypting them would be theatre with a real
   * cost: the only way to check one would be to delete the credential and type
   * it in again blind.
   *
   * The check keeps it an object, so a reader never has to handle an array or a
   * bare scalar arriving from a shared database.
   */
  it("keeps the readable half of a credential readable, and shaped", () => {
    const decl = columnDecl("api_credentials", "identifiers");
    expect(decl, "api_credentials.identifiers is missing").not.toBe("");
    expect(decl).toMatch(/\bjsonb\b/i);
    expect(decl).toMatch(/not\s+null/i);
    expect(decl).toMatch(/default\s+'\{\}'/i);
    expect(decl, "an array or a scalar here would reach the page unhandled").toMatch(
      /jsonb_typeof\s*\(\s*identifiers\s*\)\s*=\s*'object'/i,
    );
  });

  /**
   * INSERT NEEDS THE COLUMN TOO, and this is the half that is easy to forget
   * because the read path is the one somebody tests first. Without it, saving a
   * Meta credential fails at the insert with a permission error naming a column
   * the operator has never heard of.
   */
  it("lets the admin session write both halves of a credential", () => {
    const grant = /grant\s+insert\s*\(([^)]*)\)\s*on\s+shorts_scraper\.api_credentials\s+to\s+authenticated/i.exec(code);
    expect(grant, "no column-level INSERT grant on api_credentials").not.toBeNull();
    const columns = (grant?.[1] ?? "").split(",").map((c) => c.trim());
    expect(columns).toContain("secret_ciphertext");
    expect(columns).toContain("identifiers");
  });

  /**
   * A LEASE HAS TO BE USABLE ON ITS OWN.
   *
   * The Meta credential check cannot be made with an access token alone — it
   * needs the app id to form the app access token it authenticates with. The
   * identifiers could have been read separately through the admin's session,
   * since the column is granted, but a lease taken by a background job has no
   * session. It would then hold a token without the id that token must be sent
   * with: a null nobody would predict, discovered at the request.
   */
  it("returns the identifiers alongside the sealed secret, from the one door", () => {
    const signature = /create\s+function\s+shorts_scraper\.lease_api_credential[\s\S]*?returns\s+table\s*\(([^)]*)\)/i.exec(
      code,
    );
    expect(signature, "no lease_api_credential function").not.toBeNull();
    const returned = signature?.[1] ?? "";
    expect(returned).toMatch(/secret_ciphertext\s+text/i);
    expect(returned).toMatch(/identifiers\s+jsonb/i);
  });

  it("gives the plaintext door to service_role and to nobody else", () => {
    expect(code).toMatch(
      /revoke\s+execute\s+on\s+function\s+shorts_scraper\.lease_api_credential[^;]*from\s+public,\s*anon,\s*authenticated/i,
    );
    expect(code).toMatch(/grant\s+execute\s+on\s+function\s+shorts_scraper\.lease_api_credential[^;]*to\s+service_role/i);
  });

  /**
   * ONE KEY PER PROVIDER, AND SIX PROVIDERS FOR FIVE PLATFORMS.
   *
   * The enum was always SEPARATE from `shorts_scraper.platform`, on the stated
   * expectation that "the two lists will not stay parallel". They stopped being
   * parallel when Erik chose ScrapeCreators on 2026-09-04: one vendor key that
   * reads TikTok, Instagram and Facebook, which is a provider and is not a
   * platform.
   *
   * SCAR. This assertion listed exactly the five platform names, so it was one
   * of the things pinning the vendor OUT of the schema — a credential the
   * application could not save, for a client
   * (lib/platform/scrapecreators.ts) that therefore had no production call site
   * at all. It is widened deliberately here rather than because it went red and
   * was in the way.
   */
  it("holds a key per provider, one live at a time", () => {
    expect([...enumValues("credential_provider")].sort()).toEqual([
      "facebook",
      "instagram",
      "scrapecreators",
      "threads",
      "tiktok",
      "x",
      "youtube",
    ]);

    expect(code).toMatch(
      /create\s+unique\s+index\s+\w+\s+on\s+shorts_scraper\.api_credentials\s*\(\s*provider\s*\)\s*where\s+status\s*=\s*'active'/i,
    );
  });

  /**
   * THE SQL ENUM AND THE TYPESCRIPT VOCABULARY ARE ONE LIST OR THEY ARE A BUG.
   *
   * THE FAILURE THIS CLOSES, precisely. `CREDENTIAL_PROVIDERS` decides what the
   * credentials page offers, what `isCredentialProvider` accepts off a form and
   * what the registry may lease. The enum decides what Postgres will store. A
   * value in the first and not the second is a settings page that takes a key,
   * seals it, and gets a constraint violation from PostgREST naming a type the
   * operator has never heard of — with the key already typed in. A value in the
   * second and not the first is a column that can hold rows nothing will ever
   * ask for.
   *
   * Neither has a compiler. Both had a comment saying "keep these in step",
   * which is exactly the mechanism that failed: the enum sat at five platform
   * values for the whole round in which the vendor client was written, tested
   * and left with nowhere to get a key from.
   *
   * ORDER IS COMPARED TOO, not just membership. The order in
   * `CREDENTIAL_PROVIDERS` is the order the credentials page groups by —
   * platforms, then vendors — and writing the enum in a different order would
   * make two files that must be read together read differently.
   */
  it("declares exactly the providers the application knows, in the same order", () => {
    expect(enumValues("credential_provider")).toEqual([...CREDENTIAL_PROVIDERS]);
  });

  /**
   * The platform enum did NOT move, and that is half of what makes the vendor
   * value meaningful. If a vendor could be added to `platform` too, the
   * separation the credential enum exists for would be decorative.
   */
  it("did not let the vendor leak into the platform enum", () => {
    expect(enumValues("platform")).toEqual([...PLATFORMS]);
    expect(enumValues("platform")).not.toContain("scrapecreators");
  });
});

/**
 * THE SHARED-DATABASE GUARD.
 *
 * Erik decided on 2026-09-02 that this tool lands in LookUp Media's own
 * Supabase, in a database SHARED with the account's other projects, because a
 * Supabase project per tool is $10/month each. That is a cost decision with a
 * correctness consequence: a statement in this repo that names `public` no
 * longer affects only this repo.
 *
 * The concrete near-miss, and the reason this file exists in this shape: the
 * grant-locking migration used to say
 *
 *     revoke all on all tables in schema public from anon;
 *     alter default privileges in schema public revoke all on tables from anon;
 *
 * which, run against a shared database, silently strips `anon` grants from
 * EVERY co-tenant project in it. Nothing in this repo would have failed. The
 * other app's public pages would just have stopped returning rows.
 *
 * So: everything this repo creates lives in `shorts_scraper`, and the only
 * `public` allowed to survive in a migration is the Postgres PUBLIC *role*.
 */
describe("the shared database is not damaged by this tenant", () => {
  it("creates every object in the shorts_scraper schema and none in public", () => {
    const created = matchAll(
      /create\s+(?:or\s+replace\s+)?(table|function|type|view|materialized\s+view|trigger|index|sequence)\s+(?:if\s+not\s+exists\s+)?([a-z_][a-z0-9_]*)\.(\w+)/gi,
    );
    expect(created.length).toBeGreaterThan(0);
    for (const [, kind, schema, name] of created) {
      expect(schema.toLowerCase(), `create ${kind} ${schema}.${name} is outside shorts_scraper`).toBe(
        "shorts_scraper",
      );
    }
  });

  it("never grants, revokes or alters anything in schema public", () => {
    // `in schema public` reaches every co-tenant. There is no legitimate use of
    // it here, so the check is absolute rather than a judgement call.
    const offenders = matchAll(/\bin\s+schema\s+(\w+)/gi).filter(([, s]) => s.toLowerCase() !== "shorts_scraper");
    expect(offenders.map((m) => m[0])).toEqual([]);
  });

  it("never names public as a table qualifier — only ever as the PUBLIC role", () => {
    // `public.anything` is a cross-tenant reference. `from public, anon` and
    // `to public` are the role and are fine; the dot is what separates them.
    const qualified = matchAll(/\bpublic\.\w+/gi);
    expect(qualified.map((m) => m[0])).toEqual([]);
  });

  it("declares the schema, and gives anon no way into it", () => {
    expect(code).toMatch(/create\s+schema\s+(?:if\s+not\s+exists\s+)?shorts_scraper/i);

    // PostgREST connects as `anon` for an unauthenticated request. Without
    // USAGE on the schema it cannot reach a table here at all — a grant fact,
    // which survives somebody adding a permissive policy later.
    const usageGrant = /grant\s+usage\s+on\s+schema\s+shorts_scraper\s+to\s+([a-z_,\s]+);/i.exec(code);
    expect(usageGrant, "no USAGE grant on schema shorts_scraper").not.toBeNull();
    const roles = (usageGrant?.[1] ?? "").split(",").map((r) => r.trim().toLowerCase());
    expect(roles).toContain("authenticated");
    expect(roles).toContain("service_role");
    expect(roles).not.toContain("anon");
    expect(roles).not.toContain("public");

    expect(code).toMatch(/revoke\s+usage\s+on\s+schema\s+shorts_scraper\s+from\s+public,\s*anon;/i);
  });

  it("lets every role that may INSERT also execute the functions a generated column calls", () => {
    // THE DEFECT THIS ENCODES, found by the first live write this repo ever
    // made and by nothing before it:
    //
    //   upsertShorts: permission denied for function short_max_seconds
    //
    // `shorts.is_short` is `generated always as (... <= short_max_seconds())
    // stored`. Migration 05 revoked EXECUTE on that function from public and
    // anon and granted it back to nobody, reasoning in a comment that the
    // expression "is evaluated as the table owner, not as the caller". It is
    // not: a STORED generated column is evaluated during the INSERT, with the
    // INSERTING role's privileges. So every write to `shorts` failed, for every
    // role, from the day migration 05 shipped.
    //
    // Static review could not see it -- no application file calls the function,
    // so the operation scanner never reaches it. This closes that gap by
    // pairing the two facts the migrations already state: which functions a
    // generated column names, and who may insert into the table holding it.
    const generated = matchAll(
      /(\w+)\s+\w+\s+generated\s+always\s+as\s*\(([\s\S]*?)\)\s*stored/gi,
    );
    expect(generated.length, "no generated columns found — this check would be vacuous").toBeGreaterThan(0);

    const executeGrants = matchAll(
      /grant\s+execute\s+on\s+function\s+shorts_scraper\.(\w+)\s*\([^)]*\)\s*to\s+([a-z_,\s]+);/gi,
    ).map(([, fn, roles]) => ({ fn, roles: roles.split(",").map((r) => r.trim().toLowerCase()) }));

    // Which table each generated column belongs to: the nearest `create table`
    // above it in the concatenated source.
    for (const [whole, column, expression] of generated) {
      const called = [...expression.matchAll(/shorts_scraper\.(\w+)\s*\(/g)].map((m) => m[1]);
      if (called.length === 0) continue;

      const before = code.slice(0, code.indexOf(whole));
      const tables = [...before.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?shorts_scraper\.(\w+)/gi)];
      const table = tables[tables.length - 1]?.[1];
      expect(table, `could not tell which table holds the generated column ${column}`).toBeTruthy();

      // Parsed here rather than reused: `grants` belongs to another describe
      // block. Both table-wide and column-level INSERT grants count -- the
      // column form is how api_credentials is granted, and a generated column
      // on such a table would be just as broken.
      const insertGrants = [
        ...matchAll(/grant\s+([a-z,\s]+?)\s+on\s+shorts_scraper\.(\w+)\s+to\s+([a-z_,\s]+);/gi).map(
          ([, privileges, t, roles]) => ({
            table: t,
            privileges: privileges.split(",").map((x) => x.trim().toLowerCase()),
            roles: roles.split(",").map((r) => r.trim().toLowerCase()),
          }),
        ),
        ...matchAll(/grant\s+(\w+)\s*\([^)]*\)\s*on\s+shorts_scraper\.(\w+)\s+to\s+([a-z_,\s]+);/gi).map(
          ([, privilege, t, roles]) => ({
            table: t,
            privileges: [privilege.trim().toLowerCase()],
            roles: roles.split(",").map((r) => r.trim().toLowerCase()),
          }),
        ),
      ];

      const inserters = new Set(
        insertGrants
          .filter((g) => g.table === table && g.privileges.includes("insert"))
          .flatMap((g) => g.roles),
      );
      expect(inserters.size, `nothing may INSERT into ${table}, so ${column} is unreachable`).toBeGreaterThan(0);

      for (const fn of called) {
        for (const role of inserters) {
          const granted = executeGrants.some((g) => g.fn === fn && g.roles.includes(role));
          expect(
            granted,
            `${role} may INSERT into shorts_scraper.${table}, whose generated column ` +
              `${column} calls ${fn}() — but no migration grants ${role} EXECUTE on it. ` +
              "A stored generated column runs as the inserting role, so every INSERT fails " +
              "with 'permission denied for function' before RLS is ever consulted.",
          ).toBe(true);
        }
      }
    }
  });

  it("exposes shorts_scraper over PostgREST without dropping Supabase's own schemas", () => {
    // Migration 08. PostgREST refuses a schema that is not on this list before
    // it considers RLS or grants, so without it every table in this schema is
    // unreachable: {"code":"PGRST106","message":"Invalid schema: shorts_scraper"}.
    const setting = /set\s+pgrst\.db_schemas\s*=\s*'([^']+)'/i.exec(code);
    expect(setting, "no migration sets pgrst.db_schemas").not.toBeNull();

    const exposed = (setting?.[1] ?? "").split(",").map((s) => s.trim());
    expect(exposed).toContain("shorts_scraper");

    // THE VALUE IS ABSOLUTE, NOT ADDITIVE -- it replaces the whole list. Losing
    // either of these takes Supabase's own tooling offline for the project, and
    // it would look like a scraper bug.
    expect(exposed, "dropping public breaks Supabase's own tooling").toContain("public");
    expect(exposed, "dropping graphql_public breaks the GraphQL endpoint").toContain(
      "graphql_public",
    );
  });

  it("reloads PostgREST after changing what it exposes", () => {
    // Without the reload PostgREST keeps serving the old allow-list until its
    // next connection recycle, so the migration appears to have done nothing.
    // Two different staleness errors hide behind this: PGRST106 for the config,
    // PGRST205 for the schema cache.
    expect(code).toMatch(/notify\s+pgrst\s*,\s*'reload config'/i);
    expect(code).toMatch(/notify\s+pgrst\s*,\s*'reload schema'/i);
  });

  it("pins every SECURITY DEFINER function's search_path to this schema", () => {
    // A definer function with a caller-controlled search_path in a shared
    // database is the classic privilege-escalation shape: a co-tenant creates
    // `their_schema.shorts`, puts it first on the path and the definer body
    // writes there instead. Every definer here must pin it.
    const definers = matchAll(
      /create\s+(?:or\s+replace\s+)?function\s+shorts_scraper\.(\w+)[\s\S]*?as\s+\$\$/gi,
    );
    expect(definers.length).toBeGreaterThan(0);
    for (const [body, fn] of definers) {
      if (!/security\s+definer/i.test(body)) continue;
      expect(body, `${fn}() is SECURITY DEFINER with no pinned search_path`).toMatch(
        /set\s+search_path\s*=\s*shorts_scraper\b/i,
      );
    }
  });
});

/**
 * The audit's own audit.
 *
 * Every assertion in this file is a regex over `code`, and `code` is worth
 * nothing if the comment stripper does not strip. It did not, for the whole
 * life of this file, and no test noticed — see the comment on `code`.
 */
describe("the comment stripper actually strips", () => {
  const strip = (input: string) =>
    input
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((line) => line.replace(/--.*/, ""))
      .join("\n");

  it("removes -- comments whatever the line ending is", () => {
    for (const eol of ["\n", "\r\n", "\r"]) {
      const input = ["-- grant execute on function shorts_scraper.evil() to anon;", "select 1;"].join(eol);
      expect(strip(input), `line ending ${JSON.stringify(eol)}`).not.toMatch(/anon/);
      expect(strip(input), `line ending ${JSON.stringify(eol)}`).toMatch(/select 1;/);
    }
  });

  it("leaves no comment text in the `code` every other assertion runs over", () => {
    // If this fires, every other assertion in this file is suspect.
    expect(code).not.toMatch(/--/);

    // `impressions` is named repeatedly in migration prose and appears in no
    // statement, so it is a load-bearing canary rather than a tautology.
    expect(allSql).toMatch(/impressions/i);
    expect(code).not.toMatch(/impressions/i);
  });
});

/**
 * The grants a schema outside `public` does not get for free.
 *
 * Supabase ships `alter default privileges in schema public grant all on tables
 * to anon, authenticated, service_role`, so a table created in `public` is
 * reachable the moment it exists and RLS decides which rows come back. That
 * default applies to `public` and nowhere else. When the migrations were
 * re-homed into `shorts_scraper` on 2026-09-02 the tables arrived with no
 * privileges at all — which fails EARLIER than RLS, as "permission denied for
 * table shorts" rather than as zero rows, with every policy still correct.
 *
 * The table-grants migration writes them out. These assertions are what stop
 * somebody deleting it as redundant.
 */
describe("the schema move did not lose the table privileges", () => {
  const grants = matchAll(
    /grant\s+([a-z,\s]+?)\s+on\s+shorts_scraper\.(\w+)\s+to\s+([a-z_,\s]+);/gi,
  ).map(([, privileges, table, roles]) => ({
    table,
    privileges: privileges.split(",").map((p) => p.trim().toLowerCase()),
    roles: roles.split(",").map((r) => r.trim().toLowerCase()),
  }));

  const granted = (table: string, role: string) =>
    new Set(grants.filter((g) => g.table === table && g.roles.includes(role)).flatMap((g) => g.privileges));

  it.each([
    ["profiles", "authenticated", ["select", "update"]],
    ["shorts", "authenticated", ["select", "insert", "update", "delete"]],
    ["runs", "authenticated", ["select", "insert", "update"]],
    ["run_platforms", "authenticated", ["select", "insert", "update"]],
    ["credential_quota_days", "authenticated", ["select"]],
    ["shorts", "service_role", ["select", "insert", "update", "delete"]],
    ["runs", "service_role", ["select", "insert", "update"]],
    ["run_platforms", "service_role", ["select", "insert", "update"]],
  ])("grants %s to %s", (table, role, expected) => {
    const have = granted(table, role);
    for (const privilege of expected) {
      expect([...have], `${role} on ${table}`).toContain(privilege);
    }
  });

  it("never grants a table privilege to anon or PUBLIC", () => {
    for (const g of grants) {
      expect(g.roles, `grant on ${g.table}`).not.toContain("anon");
      expect(g.roles, `grant on ${g.table}`).not.toContain("public");
    }
  });

  it("never grants api_credentials table-wide — the credentials migration does it column by column", () => {
    const tableWide = grants.filter((g) => g.table === "api_credentials" && g.privileges.includes("select"));
    expect(tableWide, "a table-wide SELECT would undo the column-level grant").toEqual([]);
  });

  /**
   * Column-level grants are for `api_credentials` alone, and this is the
   * assertion that keeps it that way. A TABLE-level grant covers columns added
   * by a later migration; a column-level one does not, so a new column on a
   * narrowed table arrives unreadable — the safe direction, but a silent one.
   */
  it("keeps every other table granted table-wide, so a new column needs no grant of its own", () => {
    const narrowed = matchAll(/grant\s+select\s*\([^)]*\)\s*on\s+shorts_scraper\.(\w+)/gi).map((m) => m[1]);
    expect([...new Set(narrowed)]).toEqual(["api_credentials"]);
    expect(code).not.toMatch(/revoke\s+select\s+on\s+shorts_scraper\.shorts\b/i);
  });
});

/**
 * EVERY OPERATION THE APPLICATION PERFORMS, AGAINST THE GRANT AND THE POLICY
 * BEHIND IT.
 *
 * THIS BLOCK EXISTS BECAUSE THE MIGRATIONS AND THE CODE WERE AUDITED SEPARATELY
 * AND AGREED WITH NOBODY.
 *
 * `api_credentials` had no UPDATE grant and no UPDATE policy for
 * `authenticated`. Migration 04 said so in as many words and presented it as a
 * decision: "`last_used_at` and the check results are written by the server."
 * They are — by `SupabaseCredentialBackend.patchRow`, which
 * `resolveCredentialStore()` hands the ADMIN'S SESSION CLIENT. There is no
 * server role anywhere in that sentence. So every `noteCheck` and every
 * `noteUse` was an UPDATE issued as `authenticated` against a table granting
 * that role no UPDATE at all, and Postgres refuses those BEFORE RLS is
 * consulted.
 *
 * The failure it would have produced is the expensive kind: press "Test this
 * key", pay X or Google for a real call, watch the call succeed upstream, and
 * then read a PostgREST permission error on the credentials screen. The key
 * looks broken. The grant was.
 *
 * NOTHING IN A GREEN SUITE COULD SEE IT, and the reason is the shape of the
 * tests rather than their number. Every assertion about the store runs on
 * `MemoryCredentialBackend`, which has no grants to get wrong. Every assertion
 * about the migrations read the SQL and asked whether it said what its own
 * comments said. Neither side ever asked the other's question.
 *
 * So this block asks it. It reads the APPLICATION SOURCE, extracts the
 * PostgREST operations the code actually performs, and requires each one to
 * have a matching grant and — where it runs on a session — a matching policy.
 * It is the seam, tested from the side the application stands on.
 *
 * IT IS STILL STATIC, with the same caveat as the rest of this file: it proves
 * the migrations SAY the right thing, not that a live database IS in that
 * state. `verify/db.ts --check` is the half that reads real ACLs and it has
 * never been pointed at a database. What this catches is drift between two
 * files in this repo, which is what actually happened.
 */
describe("every operation the app performs has the grant, and the policy, to allow it", () => {
  const REPO_ROOT = path.resolve(import.meta.dirname, "..");

  /**
   * TypeScript with its comments removed, so prose about a table never counts
   * as a call to one.
   *
   * The `//` stripper deliberately refuses to fire after a colon. The scar on
   * `code` at the top of this file is the same trap in the other direction: a
   * stripper that strips too little makes assertions pass, and one that strips
   * too much — truncating a line at the `//` of an `https://` — would silently
   * delete a `.from(...)` sitting later on that line, so an operation would go
   * unaudited with nothing red.
   */
  function stripTs(src: string): string {
    return src
      .replace(/\r\n?/g, "\n")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((line) => line.replace(/(^|[^:])\/\/.*/, "$1"))
      .join("\n");
  }

  function sourceFiles(): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name === ".next") continue;
          walk(full);
          continue;
        }
        if (!/\.tsx?$/.test(entry.name)) continue;
        // A test file's fakes are not the application's operations.
        if (/\.test\.tsx?$/.test(entry.name)) continue;
        out.push(path.relative(REPO_ROOT, full).split(path.sep).join("/"));
      }
    };
    for (const root of ["lib", "app", "scripts", "verify"]) walk(path.join(REPO_ROOT, root));
    return out.sort();
  }

  /** `const SEEDS_TABLE = "platform_seeds"` — so `.from(SEEDS_TABLE)` resolves. */
  function constantsIn(src: string): Map<string, string> {
    const out = new Map<string, string>();
    for (const [, name, value] of src.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*"([^"]+)"/g)) {
      out.set(name, value);
    }
    return out;
  }

  /**
   * What a PostgREST verb needs from the database.
   *
   * `upsert` is the one worth spelling out: it is an INSERT that may become an
   * UPDATE, so a table that is upserted into and granted only INSERT works on
   * the first run against a row and fails on the second — which is the hardest
   * kind of permission bug to reproduce.
   */
  const VERB_PRIVILEGES: Record<string, readonly string[]> = {
    select: ["select"],
    insert: ["insert"],
    update: ["update"],
    upsert: ["insert", "update"],
    delete: ["delete"],
  };

  interface Operation {
    readonly file: string;
    readonly table: string;
    readonly verb: string;
  }

  const NOT_POSTGREST = /(?:Buffer|Array|Object|Set|Map|String|Uint8Array)$/;
  const FROM_CALL = /\.from\(\s*(?:"([^"]+)"|([A-Za-z_$][\w$]*))\s*\)/g;
  const VERB_CALL = /\.(select|insert|update|upsert|delete)\s*\(/;

  const unresolved: string[] = [];
  const verbless: string[] = [];

  function operationsIn(file: string): Operation[] {
    const src = stripTs(fs.readFileSync(path.join(REPO_ROOT, file), "utf8"));
    const constants = constantsIn(src);
    const out: Operation[] = [];
    for (const match of src.matchAll(FROM_CALL)) {
      const at = match.index ?? 0;
      // `Buffer.from(...)` is not a table. Anything else unrecognised is
      // REPORTED rather than skipped: a silent skip is how an operation stops
      // being audited without anybody deciding that it should be.
      if (NOT_POSTGREST.test(src.slice(Math.max(0, at - 24), at))) continue;
      const table = match[1] ?? constants.get(match[2] ?? "");
      if (table === undefined) {
        unresolved.push(`${file}: .from(${match[2]}) is neither a literal nor a const in that file`);
        continue;
      }
      const after = at + match[0].length;
      const verb = VERB_CALL.exec(src.slice(after, after + 400))?.[1];
      if (verb === undefined) {
        verbless.push(`${file}: .from(${JSON.stringify(table)}) with no verb within 400 characters`);
        continue;
      }
      out.push({ file, table, verb });
    }
    return out;
  }

  const operations = sourceFiles().flatMap((file) => operationsIn(file));
  const writerFiles = [...new Set(operations.map((o) => o.file))].sort();

  /**
   * WHICH ROLE EACH FILE'S CLIENT IS, DECIDED IN THE OPEN.
   *
   * `authenticated` and `service_role` hold different grants and only one of
   * them is subject to RLS at all, so an operation cannot be audited without
   * knowing which it runs as. This list is asserted to be EXACTLY the set of
   * files that perform one, so a new writer cannot arrive without somebody
   * choosing — the same rule the `api_credentials` column grants already
   * follow, for the same reason: the safe direction to fail in is the loud one.
   *
   * EVERY ENTRY IS NOW `service`, and that is a change, not a default. Sign-in
   * was removed on 2026-09-04, so there is no `authenticated` role to run as:
   * with no session the cookie client presents the publishable key, PostgREST
   * treats it as `anon`, and RLS -- enabled on all nine tables with no policy
   * granting `anon` anything -- returns zero rows without erroring. Every store
   * therefore goes through `createSupabaseAdminClient()`.
   *
   * `lib/auth/role.ts` has left this list because it no longer touches the
   * database at all; it returns a frozen constant.
   *
   * `lib/shorts/report-store.ts` joined it on 2026-09-05. It keeps the last run
   * so /admin/shorts survives a reload, and it is the FIRST FILE IN THIS LIST
   * THAT DELETES — the trim that holds the table to a bounded number of stored
   * screens. That privilege is granted, and the reason it may be granted here
   * when `runs` and `run_platforms` refuse it is written out in migration 12:
   * those two are the evidence separating "found nothing" from "could not be
   * read", and this is a copy of a page.
   *
   * WHAT THIS COSTS: `service_role` bypasses RLS, so the policies in migration
   * 04 no longer defend these paths -- the GRANTS below are the whole of the
   * enforcement, which is why migration 09 copies them across one privilege at
   * a time instead of granting the table.
   */
  const CLIENT_ROLE: Record<string, "session" | "service"> = {
    "lib/credentials/supabase-backend.ts": "service",
    "lib/shorts/report-store.ts": "service",
    "lib/shorts/schedule.ts": "service",
    "lib/shorts/seeds.ts": "service",
    "lib/shorts/supabase-store.ts": "service",
    // Reached through `resolveTopicStore`, which builds an admin client — the
    // same route `lib/shorts/seeds.ts` takes, and for the same reason: a run
    // has to read the topic list with no session in scope.
    "lib/shorts/topic-store.ts": "service",
    // Per-topic channels (migration 19). Reached through
    // `resolveTopicChannelStore`'s admin client — service_role, like seeds — so
    // migration 19's grants to that role are the whole of the enforcement.
    "lib/shorts/topic-channels.ts": "service",
    // The used/unused marks. /admin/library and its action both reach it through
    // `createSupabaseAdminClient`, so it runs as service_role like the rest —
    // migration 17 grants select/insert/delete to that role and, RLS being
    // bypassed by it, those grants are the whole of the enforcement.
    "lib/shorts/used-store.ts": "service",
  };

  const ROLE_OF: Record<"session" | "service", string> = {
    session: "authenticated",
    service: "service_role",
  };

  /** An unclassified file is audited as a session — the stricter of the two. */
  const roleOf = (file: string) => ROLE_OF[CLIENT_ROLE[file] ?? "session"];

  const tableGrants = matchAll(/grant\s+([a-z,\s]+?)\s+on\s+shorts_scraper\.(\w+)\s+to\s+([a-z_,\s]+);/gi).map(
    ([, privileges, table, roles]) => ({
      table,
      privileges: privileges.split(",").map((p) => p.trim().toLowerCase()),
      roles: roles.split(",").map((r) => r.trim().toLowerCase()),
      columns: null as readonly string[] | null,
    }),
  );

  const columnGrants = matchAll(
    /grant\s+(\w+)\s*\(([^)]*)\)\s*on\s+shorts_scraper\.(\w+)\s+to\s+([a-z_,\s]+);/gi,
  ).map(([, privilege, columns, table, roles]) => ({
    table,
    privileges: [privilege.trim().toLowerCase()],
    roles: roles.split(",").map((r) => r.trim().toLowerCase()),
    columns: columns.split(",").map((c) => c.trim()) as readonly string[] | null,
  }));

  const grants = [...tableGrants, ...columnGrants];

  const policies = matchAll(
    /create\s+policy\s+"([^"]+)"\s+on\s+shorts_scraper\.(\w+)\s+for\s+(\w+)\s+to\s+([a-z_,\s]+?)\s+(?:using|with)\b/gis,
  ).map(([, name, table, verb, roles]) => ({
    name,
    table,
    verb: verb.toLowerCase(),
    roles: roles.split(",").map((r) => r.trim().toLowerCase()),
  }));

  function grantsFor(table: string, role: string, privilege: string) {
    return grants.filter((g) => g.table === table && g.roles.includes(role) && g.privileges.includes(privilege));
  }

  /**
   * The columns `EncryptedCredentialStore` actually writes back, read out of
   * its own source.
   *
   * This is the half that makes a COLUMN-level grant auditable at all. A
   * table-wide grant covers whatever the code sends; a column-level one does
   * not, and a column it misses fails at runtime and nowhere else. So the grant
   * is diffed against the keys of the object literals the store passes to
   * `patchRow`, rather than against a list somebody has to remember to update.
   */
  function objectKeysPassedTo(file: string, opener: RegExp): string[] {
    const src = stripTs(fs.readFileSync(path.join(REPO_ROOT, file), "utf8"));
    const columns = new Set<string>();
    for (const match of src.matchAll(opener)) {
      const from = (match.index ?? 0) + match[0].length;
      let depth = 1;
      let i = from;
      while (i < src.length && depth > 0) {
        const ch = src[i];
        if (ch === "{" || ch === "(" || ch === "[") depth += 1;
        else if (ch === "}" || ch === ")" || ch === "]") depth -= 1;
        i += 1;
      }
      let nesting = 0;
      let current = "";
      const entries: string[] = [];
      for (const ch of src.slice(from, i - 1)) {
        if (ch === "{" || ch === "(" || ch === "[") nesting += 1;
        if (ch === "}" || ch === ")" || ch === "]") nesting -= 1;
        if (ch === "," && nesting === 0) {
          entries.push(current);
          current = "";
          continue;
        }
        current += ch;
      }
      entries.push(current);
      for (const entry of entries) {
        const key = /^\s*([A-Za-z_$][\w$]*)\s*:/.exec(entry)?.[1];
        if (key) columns.add(key);
      }
    }
    return [...columns].sort();
  }

  const patchedCredentialColumns = () =>
    objectKeysPassedTo("lib/credentials/store.ts", /patchRow\(\s*[\w.]+\s*,\s*\{/g);

  /**
   * The columns the Supabase backend NAMES IN AN INSERT, read out of its own
   * source — the other half of the same audit, and the half that was missing.
   *
   * PostgREST builds its column list from the keys of the object it is handed,
   * so this really is the statement's column list. Which is why the backend
   * writes that object out field by field instead of spreading a `CredentialRow`:
   * a spread would put this list back under the control of a type declared in
   * another file, where nothing connects it to a grant.
   */
  const insertedCredentialColumns = () =>
    objectKeysPassedTo("lib/credentials/supabase-backend.ts", /from\("api_credentials"\)\s*\.insert\(\s*\{/g);

  it("found the application's operations at all", () => {
    // A scanner that silently matches nothing turns every assertion below into
    // a pass. These four are the operations the credentials backend performs,
    // named by hand, so a broken parser fails HERE rather than reporting
    // all-clear.
    expect(unresolved).toEqual([]);
    expect(verbless).toEqual([]);
    expect(operations.length).toBeGreaterThan(0);
    const credentials = operations.filter((o) => o.table === "api_credentials").map((o) => o.verb);
    expect([...new Set(credentials)].sort()).toEqual(["delete", "insert", "select", "update"]);
  });

  it("knows which role every operating file runs as", () => {
    // Not a formality. A file whose client nobody has classified is a file
    // whose grants nobody has checked.
    expect(writerFiles).toEqual(Object.keys(CLIENT_ROLE).sort());
  });

  it("touches only tables this schema actually creates", () => {
    for (const operation of operations) {
      expect(TABLES, `${operation.file} reads shorts_scraper.${operation.table}`).toContain(operation.table);
    }
  });

  const distinct = [...new Map(operations.map((o) => [`${o.file}|${o.table}|${o.verb}`, o])).values()];

  for (const operation of distinct) {
    const role = roleOf(operation.file);

    it(`grants ${role} ${operation.verb.toUpperCase()} on ${operation.table}, for ${operation.file}`, () => {
      for (const privilege of VERB_PRIVILEGES[operation.verb]) {
        expect(
          grantsFor(operation.table, role, privilege).length,
          `${operation.file} performs ${operation.verb} on shorts_scraper.${operation.table} as ` +
            `${role}, and no migration grants ${privilege.toUpperCase()} on it to that role. ` +
            "Postgres refuses that before RLS is consulted, so it surfaces as a permission error " +
            "on the screen rather than as an empty result.",
        ).toBeGreaterThan(0);
      }
    });

    if (CLIENT_ROLE[operation.file] === "service") continue;

    it(`admits ${operation.verb.toUpperCase()} on ${operation.table} in a policy, for ${operation.file}`, () => {
      for (const privilege of VERB_PRIVILEGES[operation.verb]) {
        const admitted = policies.filter(
          (p) =>
            p.table === operation.table &&
            (p.verb === privilege || p.verb === "all") &&
            p.roles.includes("authenticated"),
        );
        expect(
          admitted.length,
          `${operation.file} performs ${operation.verb} on shorts_scraper.${operation.table} as an ` +
            `authenticated session, and no policy admits ${privilege.toUpperCase()} for that role. ` +
            "A grant without a policy reads as zero rows and writes as a refusal.",
        ).toBeGreaterThan(0);
      }
    });
  }

  /**
   * THE COLUMN-LEVEL HALF, WHICH IS WHERE THIS TABLE IS DIFFERENT FROM EVERY
   * OTHER ONE.
   *
   * `api_credentials` is granted column by column so that `secret_ciphertext`
   * is unreachable from a browser session. That protection has a cost the rest
   * of the schema does not pay: the grant must enumerate every column the
   * application writes, and one it misses fails at runtime with nothing red
   * beforehand. So the grant is diffed against the keys the store patches.
   */
  it("grants the admin session every credential column it writes back, and none of the frozen ones", () => {
    const written = patchedCredentialColumns();
    expect(written, "the parser found no patched columns, so this check would be vacuous").not.toEqual([]);

    // The role the credential store actually connects as -- `service_role`
    // since sign-in was removed. Auditing "authenticated" here would have kept
    // passing against migration 02's grants while the code wrote through a role
    // those grants never covered: green suite, 42501 on the screen.
    const storeRole = ROLE_OF[CLIENT_ROLE["lib/credentials/supabase-backend.ts"]];
    const update = grantsFor("api_credentials", storeRole, "update");
    expect(update.length, `no UPDATE grant on api_credentials for ${storeRole}`).toBeGreaterThan(0);
    const granted = [...new Set(update.flatMap((g) => g.columns ?? []))];

    for (const column of written) {
      expect(
        granted,
        `EncryptedCredentialStore writes api_credentials.${column} through the admin's session`,
      ).toContain(column);
    }

    // The whole reason this table is granted column by column. UPDATE on the
    // ciphertext would let a browser session overwrite a sealed key with
    // anything at all, which is a worse outcome than reading it.
    expect(granted, "an admin session must never be able to write the ciphertext").not.toContain(
      "secret_ciphertext",
    );
    // Nor the columns that decide which key a run leases and whose account it
    // bills. Those are set once at insert and rotated by delete-and-add.
    for (const frozen of ["provider", "status", "identifiers", "masked", "daily_quota_units"]) {
      expect(granted, `${frozen} is set at insert, never edited in place`).not.toContain(frozen);
    }
  });

  /**
   * THE SAME AUDIT ON THE INSERT SIDE, WHICH IS WHERE IT WAS MISSING.
   *
   * SCAR, 2026-09-05. The insert assertion further up this file checks that
   * `secret_ciphertext` and `identifiers` are IN the grant. It never checked the
   * other direction — that everything the code SENDS is granted — and the
   * backend was spreading a whole `CredentialRow` into `.insert()`. That row
   * type carries the four columns `patchRow` writes after a call, always null at
   * insert. PostgREST named them anyway, Postgres checked the column privileges
   * before anything else, and every save of every key came back 42501. The suite
   * stayed green because this check did not exist and the store's own tests run
   * on `MemoryCredentialBackend`, which has no grants to get wrong.
   *
   * A grant is only auditable against what the code actually writes, so this is
   * the insert-shaped copy of the UPDATE check above.
   */
  it("grants the store every credential column it inserts, and none of the recorded ones", () => {
    const written = insertedCredentialColumns();
    expect(written, "the parser found no inserted columns, so this check would be vacuous").not.toEqual([]);

    const storeRole = ROLE_OF[CLIENT_ROLE["lib/credentials/supabase-backend.ts"]];
    const insert = grantsFor("api_credentials", storeRole, "insert");
    expect(insert.length, `no INSERT grant on api_credentials for ${storeRole}`).toBeGreaterThan(0);
    const granted = [...new Set(insert.flatMap((g) => g.columns ?? []))];

    for (const column of written) {
      expect(
        granted,
        `SupabaseCredentialBackend names api_credentials.${column} in its INSERT as ${storeRole}, and no ` +
          "migration grants INSERT on that column to that role. Postgres refuses the whole statement " +
          "with 42501 before RLS is consulted, so it reaches the operator as a save that will never work.",
      ).toContain(column);
    }

    // The four the insert must NOT name. They are what a call RECORDS about a
    // key -- written by `patchRow` under the separate UPDATE grant, null until
    // then. Naming them in the insert is the exact regression above, and it
    // costs nothing to say so by name rather than to rely on the grant lookup.
    for (const recorded of ["last_used_at", "last_check_ok", "last_check_at", "last_check_error"]) {
      expect(written, `${recorded} is recorded after a call, never written at insert`).not.toContain(recorded);
    }
  });
});
