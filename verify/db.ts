/**
 * The live-database audit. Plan l35-shorts-scraper-2026-004, Phase 1.
 *
 *   pnpm exec tsx verify/db.ts --selftest     offline; no database, no network
 *   pnpm exec tsx verify/db.ts --check        read-only introspection of a real database
 *   pnpm exec tsx verify/db.ts --roundtrip    behavioural proofs, inside a rolled-back transaction
 *
 * WHY THIS EXISTS
 *
 * `tests/migrations.test.ts` reads the migration SQL and asserts over the text.
 * Its own docstring says what that is worth: it proves the migrations SAY the
 * right thing, not that a database IS in that state. The gap between those two
 * claims is where the `impressions` finding lived — the design said three
 * functions were reachable by `anon`, and an audit of the real grants found
 * twelve of fifteen. No amount of reading the migrations would have found it.
 * Reading `pg_proc` did.
 *
 * So this asks the database. `--check` is read-only and safe to run against
 * production at any time by anybody.
 *
 * IT IS RED UNTIL THERE IS A DATABASE, AND THAT IS THE HONEST STATE
 *
 * Erik decided on 2026-09-02 (plan open question Q4) that this lands on LookUp
 * Media's own Supabase, in a database SHARED with the account's other projects,
 * because a project per tool costs $10/month each. No project reference has been
 * handed over yet, so `--check` has never been run and every claim in this repo
 * about the live schema is still unverified. `--selftest` passes offline and
 * proves the CHECKS work; it does not and must not be read as proving the
 * DATABASE is right. The two are printed differently for that reason.
 *
 * THE SHARED DATABASE CHANGES WHAT IS SAFE
 *
 * Every probe is read-only and scoped to the `shorts_scraper` schema. The one
 * exception is the `public` footprint check, which looks — and only looks — for
 * objects this tool owns sitting in a namespace it does not. `--roundtrip`
 * writes, but only inside a transaction it always rolls back, and it never
 * touches `auth` or any co-tenant schema.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { Client } from "pg";

import { auditSnapshot, countBy, isClean, type Finding } from "../lib/db-audit/audit";
import { MUTATIONS, healthySnapshot } from "../lib/db-audit/fixtures";
import { AUDIT_SCHEMA, PROBES, type DbSnapshot } from "../lib/db-audit/snapshot";

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const mark = (s: Finding["status"]) => (s === "ok" ? "  ok  " : s === "fail" ? " FAIL " : "  ??  ");

function report(findings: readonly Finding[]): void {
  for (const f of findings) {
    console.log(`[${mark(f.status)}] ${f.id.padEnd(28)} ${f.claim}`);
    if (f.detail) {
      for (const line of wrap(f.detail, 86)) console.log(`             ${line}`);
      console.log(`             source: ${f.source}`);
    }
  }
  const failed = countBy(findings, "fail");
  const unknowns = countBy(findings, "unknown");
  console.log("");
  console.log(
    `${findings.length} checks: ${countBy(findings, "ok")} ok, ${failed} failed, ${unknowns} could not be determined.`,
  );
  if (unknowns > 0) {
    console.log("A check that could not be determined is NOT a check that passed.");
  }
}

function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (line.length + word.length + 1 > width) {
      out.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) out.push(line);
  return out;
}

// ---------------------------------------------------------------------------
// Connecting
// ---------------------------------------------------------------------------

function connectionString(argv: readonly string[]): string | null {
  const i = argv.indexOf("--db-url");
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  return process.env.SUPABASE_DB_URL?.trim() || null;
}

/**
 * TLS, said out loud rather than defaulted quietly.
 *
 * Supabase serves Postgres over TLS with a certificate that public CA bundles
 * do not chain to, so `ssl: true` fails on a stock Node install and the usual
 * workaround is to turn verification off. That workaround is a real downgrade —
 * it protects against passive sniffing and not against an active
 * man-in-the-middle — so it is opt-in here, printed on every run, and
 * `--ca <file>` (the project's certificate from Settings -> Database -> SSL
 * configuration) is the version that actually verifies.
 */
function tlsOptions(argv: readonly string[]): { ssl: object; note: string } {
  const i = argv.indexOf("--ca");
  if (i >= 0 && i + 1 < argv.length) {
    const ca = fs.readFileSync(path.resolve(argv[i + 1]), "utf8");
    return { ssl: { ca, rejectUnauthorized: true }, note: `TLS verified against ${argv[i + 1]}` };
  }
  return {
    ssl: { rejectUnauthorized: false },
    note:
      "TLS is ENCRYPTED BUT NOT VERIFIED. Pass --ca <prod-ca.crt> (Supabase dashboard -> " +
      "Settings -> Database -> SSL configuration) to verify the certificate.",
  };
}

// ---------------------------------------------------------------------------
// Reading the database into a snapshot
// ---------------------------------------------------------------------------

async function takeSnapshot(client: Client): Promise<DbSnapshot> {
  const q = async (sql: string) => (await client.query(sql)).rows as Record<string, unknown>[];

  const schemaExists = Boolean((await q(PROBES.schemaExists))[0]?.present);
  if (!schemaExists) {
    return {
      schemaExists: false,
      schemaGrants: [],
      tables: [],
      policies: [],
      functions: [],
      tableGrants: [],
      columnGrants: [],
      triggers: [],
      generatedColumns: [],
      objectsOutsideSchema: [],
      exposedToPostgrest: null,
    };
  }

  const [grants, tables, policies, fns, fnGrants, tableGrants, columnGrants, triggers, generated, outside, pgrst] =
    await Promise.all([
      q(PROBES.schemaGrants),
      q(PROBES.tables),
      q(PROBES.policies),
      q(PROBES.functions),
      q(PROBES.functionGrants),
      q(PROBES.tableGrants),
      q(PROBES.columnGrants),
      q(PROBES.triggers),
      q(PROBES.generatedColumns),
      q(PROBES.objectsOutsideSchema),
      q(PROBES.exposedToPostgrest),
    ]);

  const key = (name: unknown, args: unknown) => `${String(name)}(${String(args)})`;
  const grantsByFunction = new Map<string, { grantee: string; privilege: string }[]>();
  for (const row of fnGrants) {
    const k = key(row.name, row.identity_arguments);
    const list = grantsByFunction.get(k) ?? [];
    list.push({ grantee: String(row.grantee), privilege: String(row.privilege) });
    grantsByFunction.set(k, list);
  }

  const settings = String(pgrst[0]?.settings ?? "");
  // `pgrst.db_schemas="public, shorts_scraper"` when it has been configured at
  // all; an empty string means the setting is not on the authenticator role and
  // we genuinely cannot tell from here.
  const exposedToPostgrest = settings === "" ? null : new RegExp(`\\b${AUDIT_SCHEMA}\\b`).test(settings);

  return {
    schemaExists: true,
    schemaGrants: grants.map((r) => ({ grantee: String(r.grantee), privilege: String(r.privilege) })),
    tables: tables.map((r) => ({
      table: String(r.table),
      rlsEnabled: Boolean(r.rls_enabled),
      rlsForced: Boolean(r.rls_forced),
    })),
    policies: policies.map((r) => ({
      table: String(r.table),
      policy: String(r.policy),
      roles: ((r.roles as string[]) ?? []).filter((x) => x !== "-"),
      command: String(r.command),
    })),
    functions: fns.map((r) => ({
      name: String(r.name),
      identityArguments: String(r.identity_arguments ?? ""),
      securityDefiner: Boolean(r.security_definer),
      config: (r.config as string[]) ?? [],
      grants: grantsByFunction.get(key(r.name, r.identity_arguments)) ?? [],
    })),
    tableGrants: tableGrants.map((r) => ({
      table: String(r.table),
      grantee: String(r.grantee),
      privilege: String(r.privilege),
    })),
    columnGrants: columnGrants.map((r) => ({
      table: String(r.table),
      column: String(r.column),
      grantee: String(r.grantee),
      privilege: String(r.privilege),
    })),
    triggers: triggers.map((r) => ({
      table: String(r.table),
      trigger: String(r.trigger),
      timing: String(r.timing),
      events: (r.events as string[]) ?? [],
    })),
    generatedColumns: generated.map((r) => ({
      table: String(r.table),
      column: String(r.column),
      expression: String(r.expression),
    })),
    objectsOutsideSchema: outside.map((r) => ({
      schema: String(r.schema),
      kind: String(r.kind),
      name: String(r.name),
    })),
    exposedToPostgrest,
  };
}

// ---------------------------------------------------------------------------
// --check
// ---------------------------------------------------------------------------

async function check(argv: readonly string[]): Promise<number> {
  const url = connectionString(argv);
  if (!url) {
    console.log("");
    console.log("NOT RUN — no SUPABASE_DB_URL, so this audit has nothing to connect to.");
    console.log("");
    console.log("  A live project DOES exist now (ref czesslsokncmiszipwah, applied and");
    console.log("  exercised on 2026-09-04: write, read, idempotent re-write, delete). What is");
    console.log("  missing is not the database, it is the DATABASE PASSWORD.");
    console.log("");
    console.log("  These checks read pg_class, pg_policies and pg_proc, which only travel over");
    console.log("  the Postgres wire protocol. No API key substitutes — not the publishable");
    console.log("  key, not the service-role key, which speak to PostgREST rather than to");
    console.log("  Postgres. The password is in Erik's password manager and has never been");
    console.log("  handled by this repo.");
    console.log("");
    console.log("  So a narrower thing HAS been established than this audit would establish:");
    console.log("  that the app's own reads and writes work through PostgREST. What is still");
    console.log("  unverified here is the schema's shape as Postgres holds it — every table,");
    console.log("  every policy, every grant, checked claim by claim rather than inferred from");
    console.log("  one round trip that happened to pass.");
    console.log("");
    console.log("  Give it one with:");
    console.log("    pnpm exec tsx verify/db.ts --check --db-url postgresql://...");
    console.log("    SUPABASE_DB_URL=postgresql://... pnpm exec tsx verify/db.ts --check");
    console.log("");
    console.log("  This is RED on purpose. It is the difference between 'the schema is correct'");
    console.log("  and 'the migrations say the schema would be correct', and only one of those");
    console.log("  has been established. Do not report it as passing.");
    console.log("");
    return 1;
  }

  const tls = tlsOptions(argv);
  console.log(tls.note);
  const client = new Client({ connectionString: url, ...tls, application_name: "shorts-scraper verify/db" });
  await client.connect();
  try {
    const snapshot = await takeSnapshot(client);
    if (argv.includes("--json")) {
      console.log(JSON.stringify(snapshot, null, 2));
      return 0;
    }
    const findings = auditSnapshot(snapshot);
    report(findings);
    return isClean(findings) ? 0 : 1;
  } finally {
    await client.end();
  }
}

// ---------------------------------------------------------------------------
// --roundtrip: the behaviour, not the shape
// ---------------------------------------------------------------------------

interface Behaviour {
  readonly name: string;
  readonly claim: string;
  readonly run: (client: Client) => Promise<string | null>; // null = passed, string = what went wrong
}

const CH = "UCverifyroundtrip0000001";

/**
 * Behavioural proofs. Every one of these runs inside a transaction that is
 * ALWAYS rolled back, so `--roundtrip` is safe against the shared production
 * database. It writes nothing to `auth` and nothing to any other schema.
 *
 * These are the Phase 1 acceptance criteria that a static read of the SQL
 * cannot establish, because they are about what Postgres DOES with the trigger
 * and the indexes, not about what the migration says.
 */
const BEHAVIOURS: readonly Behaviour[] = [
  {
    name: "sticky-unlist",
    claim: "an ingest-style UPDATE cannot move a channel out of 'unlisted'",
    run: async (c) => {
      await c.query(
        `insert into ${AUDIT_SCHEMA}.channels (channel_id, handle, title, state)
         values ($1, '@verify', 'verify', 'unlisted')`,
        [CH],
      );
      // Exactly what a seeded or discovery run does when it meets the channel
      // again: refresh the metadata, leave the human's decision alone.
      await c.query(
        `update ${AUDIT_SCHEMA}.channels
            set title = 'refreshed by ingest', state = 'candidate'
          where channel_id = $1`,
        [CH],
      );
      const { rows } = await c.query(
        `select state from ${AUDIT_SCHEMA}.channels where channel_id = $1`,
        [CH],
      );
      return rows[0]?.state === "unlisted"
        ? null
        : `state became '${rows[0]?.state}'. An unlisted channel was resurrected by an automated write, ` +
            `which is the one guarantee the client asked for by name.`;
    },
  },
  {
    name: "no-duplicate-videos",
    claim: "re-running ingest over the same channel writes no duplicate videos",
    run: async (c) => {
      await c.query(
        `insert into ${AUDIT_SCHEMA}.channels (channel_id, handle, title) values ($1, '@dup', 'dup')`,
        [CH],
      );
      const insert = `insert into ${AUDIT_SCHEMA}.videos (video_id, channel_id, title, duration_seconds)
                      values ('vidverify001', $1, 'v', 42)
                      on conflict (video_id) do update set title = excluded.title`;
      await c.query(insert, [CH]);
      await c.query(insert, [CH]);
      const { rows } = await c.query(
        `select count(*)::int as n from ${AUDIT_SCHEMA}.videos where channel_id = $1`,
        [CH],
      );
      return rows[0]?.n === 1 ? null : `${rows[0]?.n} rows for one video id — the unique key is not doing its job.`;
    },
  },
  {
    name: "provenance-accumulates",
    claim: "a channel found twice gets two channel_sources rows and stays one channel",
    run: async (c) => {
      await c.query(
        `insert into ${AUDIT_SCHEMA}.channels (channel_id, handle, title) values ($1, '@prov', 'prov')`,
        [CH],
      );
      await c.query(
        `insert into ${AUDIT_SCHEMA}.channel_sources (channel_id, source, found_by)
         values ($1, 'seed', 'verify'), ($1, 'discovery:keyword', 'verify')`,
        [CH],
      );
      const { rows } = await c.query(
        `select (select count(*) from ${AUDIT_SCHEMA}.channels where channel_id = $1)::int as channels,
                (select count(*) from ${AUDIT_SCHEMA}.channel_sources where channel_id = $1)::int as sources`,
        [CH],
      );
      return rows[0]?.channels === 1 && rows[0]?.sources === 2
        ? null
        : `${rows[0]?.channels} channel row(s), ${rows[0]?.sources} provenance row(s) — expected 1 and 2.`;
    },
  },
  {
    name: "anon-locked-out",
    claim: "the anon role cannot read the inventory at all",
    run: async (c) => {
      await c.query("set local role anon");
      try {
        await c.query(`select 1 from ${AUDIT_SCHEMA}.channels limit 1`);
        return "anon read the table. PostgREST connects as anon for every unauthenticated request.";
      } catch (e) {
        const code = (e as { code?: string }).code;
        // 42501 insufficient_privilege, 3F000 invalid_schema_name — both mean
        // anon cannot see the schema, which is the intended outcome.
        return code === "42501" || code === "3F000"
          ? null
          : `unexpected error ${code}: ${(e as Error).message}`;
      } finally {
        await c.query("set local role none").catch(() => undefined);
      }
    },
  },
  {
    name: "co-tenant-user-sees-nothing",
    claim: "a signed-in user from another project in this database reads no rows",
    run: async (c) => {
      // THE ISOLATION BOUNDARY OF A SHARED DATABASE, tested rather than argued.
      // `auth.users` is per-database, so anybody who signs up for a co-tenant
      // app in this project holds a valid JWT here too. They get nothing
      // because authorisation runs off shorts_scraper.profiles and there is
      // deliberately no trigger creating one on signup.
      await c.query(
        `insert into ${AUDIT_SCHEMA}.channels (channel_id, handle, title) values ($1, '@iso', 'iso')`,
        [CH],
      );
      await c.query("set local role authenticated");
      await c.query(
        `select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000dead","role":"authenticated"}', true)`,
      );
      try {
        const { rows } = await c.query(`select count(*)::int as n from ${AUDIT_SCHEMA}.channels`);
        return rows[0]?.n === 0
          ? null
          : `a stranger with a valid JWT and no profile row read ${rows[0]?.n} channel(s).`;
      } finally {
        await c.query("set local role none").catch(() => undefined);
      }
    },
  },
];

async function roundtrip(argv: readonly string[]): Promise<number> {
  const url = connectionString(argv);
  if (!url) {
    console.log("NOT RUN — no database. See `verify/db.ts --check` for why, and pass --db-url.");
    return 1;
  }
  const tls = tlsOptions(argv);
  console.log(tls.note);
  console.log("Every behaviour below runs in its own transaction and is ALWAYS rolled back.");
  console.log("");

  const client = new Client({ connectionString: url, ...tls, application_name: "shorts-scraper verify/db" });
  await client.connect();
  let failures = 0;
  try {
    for (const b of BEHAVIOURS) {
      await client.query("begin");
      let problem: string | null;
      try {
        problem = await b.run(client);
      } catch (e) {
        problem = `threw: ${(e as Error).message}`;
      } finally {
        // Unconditional. A behaviour that passes and a behaviour that throws
        // both leave the database exactly as they found it.
        await client.query("rollback");
      }
      console.log(`[${problem === null ? "  ok  " : " FAIL "}] ${b.name.padEnd(28)} ${b.claim}`);
      if (problem !== null) {
        for (const line of wrap(problem, 86)) console.log(`             ${line}`);
        failures += 1;
      }
    }
  } finally {
    await client.end();
  }
  console.log("");
  console.log(`${BEHAVIOURS.length} behaviours: ${BEHAVIOURS.length - failures} ok, ${failures} failed.`);
  return failures === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// --selftest
// ---------------------------------------------------------------------------

/**
 * Offline. Proves the CHECKS work, and says plainly that this is not the same
 * as proving the DATABASE is right.
 */
function selftest(): number {
  const healthy = auditSnapshot(healthySnapshot());
  const stillFailing = healthy.filter((f) => f.status === "fail");
  if (stillFailing.length > 0) {
    console.log("SELFTEST FAILED: the expected-good snapshot does not pass its own audit.");
    report(healthy);
    return 1;
  }

  let broken = 0;
  for (const m of MUTATIONS) {
    const findings = auditSnapshot(m.apply(healthySnapshot()));
    const target = findings.find((f) => f.id === m.expectFailure);
    if (target?.status !== "fail") {
      console.log(`SELFTEST FAILED: mutation "${m.name}" did not turn ${m.expectFailure} red.`);
      broken += 1;
    }
  }
  if (broken > 0) return 1;

  console.log(`selftest ok — ${healthy.length} checks, ${MUTATIONS.length} mutations, every one of them bites.`);
  console.log("");
  console.log("THIS PROVES THE CHECKS WORK. IT PROVES NOTHING ABOUT ANY DATABASE.");
  console.log("No database has been migrated yet: LookUp Media's Supabase project reference has");
  console.log("not been handed over. Run --check against it before repeating any claim in this");
  console.log("repo about live grants, RLS or the unlist guard.");
  return 0;
}

// ---------------------------------------------------------------------------

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  if (argv.includes("--selftest")) return selftest();
  if (argv.includes("--roundtrip")) return roundtrip(argv);
  if (argv.includes("--check")) return check(argv);

  console.log("usage: tsx verify/db.ts [--selftest | --check | --roundtrip] [--db-url <url>] [--ca <file>]");
  console.log("");
  console.log("  --selftest    offline; proves the checks bite. No database, no network.");
  console.log("  --check       read-only introspection of a live database. Safe on production.");
  console.log("  --roundtrip   behavioural proofs, each in a transaction that is always rolled back.");
  return 2;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]).toLowerCase() === path.resolve(import.meta.filename).toLowerCase();

if (invokedDirectly) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}
