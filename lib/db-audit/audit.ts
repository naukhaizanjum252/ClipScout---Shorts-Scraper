/**
 * The findings. A pure function from a database snapshot to a verdict.
 *
 * Every check here restates one line of the plan's Phase 1 acceptance, or one
 * consequence of Erik's 2026-09-02 decision to share a database. The point of
 * keeping it pure is that `verify/db.ts --selftest` can feed it deliberately
 * broken snapshots and assert that each one goes red — so the audit is known to
 * bite BEFORE it is ever pointed at LookUp Media's database, rather than being
 * a green tick nobody has tested.
 *
 * A check that cannot be answered from the snapshot reports UNKNOWN, never OK.
 * "The check passed" and "the check did not run" must not look the same; that
 * is the same rule `verify/quota.ts` follows when it reports INERT.
 */
import { SHORT_MAX_SECONDS_DEFAULT } from "../config";
import { AUDIT_SCHEMA, type DbSnapshot } from "./snapshot";

export type Status = "ok" | "fail" | "unknown";

export interface Finding {
  /** Stable id, so a report can be diffed between runs. */
  readonly id: string;
  readonly status: Status;
  /** What the check is for, in one line. */
  readonly claim: string;
  /** What was actually observed. Empty on a clean pass. */
  readonly detail: string;
  /** Where the requirement comes from, so a reader can argue with it. */
  readonly source: string;
}

/** Tables every migration set is expected to have produced. */
const EXPECTED_TABLES = [
  "profiles",
  "channels",
  "videos",
  "channel_sources",
  "runs",
  "api_credentials",
  "credential_quota_days",
] as const;

/**
 * Who may do what, mirroring supabase/migrations/20260902_06_table_grants.sql.
 *
 * Kept as data so the grant list and the policy list can be diffed by eye — and
 * so that `authenticated` NOT holding UPDATE on `channels` is an assertion
 * rather than an omission.
 */
const EXPECTED_GRANTS: ReadonlyArray<readonly [string, string, readonly string[]]> = [
  ["profiles", "authenticated", ["SELECT", "UPDATE"]],
  ["channels", "authenticated", ["SELECT", "INSERT", "DELETE"]],
  ["videos", "authenticated", ["SELECT", "INSERT", "UPDATE", "DELETE"]],
  ["channel_sources", "authenticated", ["SELECT", "INSERT"]],
  ["runs", "authenticated", ["SELECT", "INSERT", "UPDATE"]],
  ["credential_quota_days", "authenticated", ["SELECT"]],
  ["channels", "service_role", ["SELECT", "INSERT", "UPDATE", "DELETE"]],
  ["videos", "service_role", ["SELECT", "INSERT", "UPDATE", "DELETE"]],
  ["channel_sources", "service_role", ["SELECT", "INSERT"]],
  ["runs", "service_role", ["SELECT", "INSERT", "UPDATE"]],
];

function ok(id: string, claim: string, source: string): Finding {
  return { id, status: "ok", claim, detail: "", source };
}
function fail(id: string, claim: string, detail: string, source: string): Finding {
  return { id, status: "fail", claim, detail, source };
}
function unknown(id: string, claim: string, detail: string, source: string): Finding {
  return { id, status: "unknown", claim, detail, source };
}

const PLAN = "plan l35-shorts-scraper-2026-004, Phase 1 acceptance";
const SHARED = "Erik, 2026-09-02: shared database, one schema per tool (plan Q4)";

export function auditSnapshot(snap: DbSnapshot): Finding[] {
  const findings: Finding[] = [];

  // -------------------------------------------------------------------------
  // The schema itself
  // -------------------------------------------------------------------------
  if (!snap.schemaExists) {
    // Everything downstream reads as "no objects found", which would otherwise
    // pass every check vacuously. Stop here and say so.
    return [
      fail(
        "schema-exists",
        `schema ${AUDIT_SCHEMA} exists`,
        `not present. The migrations have not been applied to this database. ` +
          `Every other check below would pass vacuously, so they were not run.`,
        SHARED,
      ),
    ];
  }
  findings.push(ok("schema-exists", `schema ${AUDIT_SCHEMA} exists`, SHARED));

  // -------------------------------------------------------------------------
  // anon cannot get into the schema at all
  // -------------------------------------------------------------------------
  const usage = snap.schemaGrants.filter((g) => g.privilege.toUpperCase() === "USAGE");
  const grantee = (name: string) => usage.some((g) => g.grantee.toLowerCase() === name.toLowerCase());

  const leaked = ["anon", "PUBLIC"].filter((r) => grantee(r));
  findings.push(
    leaked.length === 0
      ? ok("anon-no-schema-usage", `anon and PUBLIC have no USAGE on ${AUDIT_SCHEMA}`, SHARED)
      : fail(
          "anon-no-schema-usage",
          `anon and PUBLIC have no USAGE on ${AUDIT_SCHEMA}`,
          `USAGE is held by: ${leaked.join(", ")}. PostgREST connects as anon for an ` +
            `unauthenticated request, so this is the outermost door and it is open.`,
          SHARED,
        ),
  );

  for (const role of ["authenticated", "service_role"]) {
    findings.push(
      grantee(role)
        ? ok(`${role}-schema-usage`, `${role} has USAGE on ${AUDIT_SCHEMA}`, SHARED)
        : fail(
            `${role}-schema-usage`,
            `${role} has USAGE on ${AUDIT_SCHEMA}`,
            `missing. The app will fail every query as ${role}, which looks like a broken ` +
              `build rather than a missing grant.`,
            SHARED,
          ),
    );
  }

  // -------------------------------------------------------------------------
  // Tables, and RLS on all of them
  // -------------------------------------------------------------------------
  const tableNames = snap.tables.map((t) => t.table);
  const missing = EXPECTED_TABLES.filter((t) => !tableNames.includes(t));
  findings.push(
    missing.length === 0
      ? ok("tables-present", "every table the migrations create exists", PLAN)
      : fail("tables-present", "every table the migrations create exists", `missing: ${missing.join(", ")}`, PLAN),
  );

  const noRls = snap.tables.filter((t) => !t.rlsEnabled).map((t) => t.table);
  findings.push(
    noRls.length === 0
      ? ok("rls-everywhere", "row level security is enabled on every table", PLAN)
      : fail("rls-everywhere", "row level security is enabled on every table", `RLS off on: ${noRls.join(", ")}`, PLAN),
  );

  // -------------------------------------------------------------------------
  // The privileges that `public` would have handed out for free
  // -------------------------------------------------------------------------
  //
  // Migration 06 exists because moving off `public` lost Supabase's default
  // `grant all on tables to anon, authenticated, service_role`. Without those
  // grants every query fails with "permission denied for table channels" —
  // which fails EARLIER than RLS, so no policy is wrong and nothing in the
  // static audit notices. This is the check that would have caught it.
  const held = (table: string, role: string) =>
    new Set(
      snap.tableGrants
        .filter((g) => g.table === table && g.grantee.toLowerCase() === role)
        .map((g) => g.privilege.toUpperCase()),
    );

  const missingGrants: string[] = [];
  for (const [table, role, privileges] of EXPECTED_GRANTS) {
    const have = held(table, role);
    const absent = privileges.filter((p) => !have.has(p));
    if (absent.length > 0) missingGrants.push(`${role} lacks ${absent.join("/")} on ${table}`);
  }
  findings.push(
    missingGrants.length === 0
      ? ok("grants-present", "the app's roles can reach the tables their policies allow", SHARED)
      : fail(
          "grants-present",
          "the app's roles can reach the tables their policies allow",
          missingGrants.join("; ") +
            `. This reads as "permission denied for table ...", not as zero rows, and every ` +
            `RLS policy can be perfectly correct while it happens.`,
          SHARED,
        ),
  );

  const anonGrants = snap.tableGrants.filter((g) => ["anon", "public"].includes(g.grantee.toLowerCase()));
  findings.push(
    anonGrants.length === 0
      ? ok("no-anon-table-grant", "anon holds no table privilege in this schema", PLAN)
      : fail(
          "no-anon-table-grant",
          "anon holds no table privilege in this schema",
          anonGrants.map((g) => `${g.grantee}: ${g.privilege} on ${g.table}`).join(", "),
          PLAN,
        ),
  );

  // The unlist invariant, expressed as a privilege rather than as a policy.
  const channelUpdaters = snap.tableGrants.filter(
    (g) => g.table === "channels" && g.privilege.toUpperCase() === "UPDATE" && g.grantee.toLowerCase() === "authenticated",
  );
  findings.push(
    channelUpdaters.length === 0
      ? ok("no-session-update-on-channels", "authenticated holds no UPDATE privilege on channels", PLAN)
      : fail(
          "no-session-update-on-channels",
          "authenticated holds no UPDATE privilege on channels",
          `granted. Adding an UPDATE policy would then be enough to move a channel's state ` +
            `without going through set_channel_state(), and unlisting stops being attributable.`,
          PLAN,
        ),
  );

  // -------------------------------------------------------------------------
  // No policy reaches anon — the acceptance criterion, asked of the database
  // -------------------------------------------------------------------------
  const anonPolicies = snap.policies.filter((p) => {
    const roles = p.roles.map((r) => r.toLowerCase());
    // An empty `to` clause means PUBLIC, which includes anon. A policy that
    // names `public` explicitly is the same thing spelled differently.
    return roles.length === 0 || roles.includes("anon") || roles.includes("public");
  });
  findings.push(
    anonPolicies.length === 0
      ? ok("no-anon-policy", "no RLS policy is reachable by anon", PLAN)
      : fail(
          "no-anon-policy",
          "no RLS policy is reachable by anon",
          anonPolicies
            .map((p) => `${p.table}.${p.policy} (${p.command}) -> ${p.roles.length ? p.roles.join(", ") : "PUBLIC"}`)
            .join("; "),
          PLAN,
        ),
  );

  // -------------------------------------------------------------------------
  // No function is EXECUTE-able by anon — BOTH doors, asked as a capability
  // -------------------------------------------------------------------------
  const anonExecutable = snap.functions.filter((f) =>
    f.grants.some(
      (g) => g.privilege.toUpperCase() === "EXECUTE" && ["anon", "public"].includes(g.grantee.toLowerCase()),
    ),
  );
  findings.push(
    anonExecutable.length === 0
      ? ok("no-anon-execute", "no function is EXECUTE-able by anon or PUBLIC", PLAN)
      : fail(
          "no-anon-execute",
          "no function is EXECUTE-able by anon or PUBLIC",
          `${anonExecutable.length} of ${snap.functions.length}: ` +
            anonExecutable.map((f) => `${f.name}(${f.identityArguments})`).join(", ") +
            `. This is the exact shape of the impressions finding — twelve of fifteen — and ` +
            `it is invisible to a test that reads the migration text.`,
          PLAN,
        ),
  );

  // -------------------------------------------------------------------------
  // SECURITY DEFINER functions pin their search_path
  // -------------------------------------------------------------------------
  const definers = snap.functions.filter((f) => f.securityDefiner);
  const unpinned = definers.filter(
    (f) => !f.config.some((c) => /^search_path=/i.test(c) && c.toLowerCase().includes(AUDIT_SCHEMA)),
  );
  findings.push(
    definers.length === 0
      ? unknown(
          "definer-search-path",
          "every SECURITY DEFINER function pins search_path",
          "no SECURITY DEFINER functions found, which is itself unexpected — the state " +
            "machine and the credential lease are both definers.",
          SHARED,
        )
      : unpinned.length === 0
        ? ok("definer-search-path", "every SECURITY DEFINER function pins search_path", SHARED)
        : fail(
            "definer-search-path",
            "every SECURITY DEFINER function pins search_path",
            `unpinned: ${unpinned.map((f) => f.name).join(", ")}. In a shared database a co-tenant ` +
              `can create a table earlier on the path and the definer body writes to theirs.`,
            SHARED,
          ),
  );

  // -------------------------------------------------------------------------
  // The ciphertext column is unreachable by a browser session
  // -------------------------------------------------------------------------
  const ciphertextReaders = snap.columnGrants.filter(
    (g) =>
      g.table === "api_credentials" &&
      g.column === "secret_ciphertext" &&
      ["anon", "authenticated", "public"].includes(g.grantee.toLowerCase()),
  );
  findings.push(
    ciphertextReaders.length === 0
      ? ok(
          "ciphertext-unreadable",
          "api_credentials.secret_ciphertext is unreadable by anon and authenticated",
          PLAN,
        )
      : fail(
          "ciphertext-unreadable",
          "api_credentials.secret_ciphertext is unreadable by anon and authenticated",
          `readable by: ${ciphertextReaders.map((g) => g.grantee).join(", ")}. An admin's browser ` +
            `session can then fetch every operator's sealed key with select=*.`,
          PLAN,
        ),
  );

  // -------------------------------------------------------------------------
  // The plaintext door belongs to service_role alone
  // -------------------------------------------------------------------------
  const lease = snap.functions.find((f) => f.name === "lease_api_credential");
  if (!lease) {
    findings.push(
      fail(
        "lease-service-role-only",
        "lease_api_credential is callable by service_role and nobody else",
        "function not found",
        PLAN,
      ),
    );
  } else {
    const callers = lease.grants
      .filter((g) => g.privilege.toUpperCase() === "EXECUTE")
      .map((g) => g.grantee.toLowerCase())
      .filter((g) => g !== "service_role");
    findings.push(
      callers.length === 0
        ? ok("lease-service-role-only", "lease_api_credential is callable by service_role and nobody else", PLAN)
        : fail(
            "lease-service-role-only",
            "lease_api_credential is callable by service_role and nobody else",
            `also callable by: ${callers.join(", ")}. This is the only path in the system that ` +
              `yields a plaintext API key.`,
            PLAN,
          ),
    );
  }

  // -------------------------------------------------------------------------
  // The unlist state machine
  // -------------------------------------------------------------------------
  const channelUpdatePolicies = snap.policies.filter(
    (p) => p.table === "channels" && ["UPDATE", "ALL"].includes(p.command.toUpperCase()),
  );
  findings.push(
    channelUpdatePolicies.length === 0
      ? ok("channels-no-update-policy", "no session can UPDATE channels directly", PLAN)
      : fail(
          "channels-no-update-policy",
          "no session can UPDATE channels directly",
          `policies allowing it: ${channelUpdatePolicies.map((p) => p.policy).join(", ")}. State must ` +
            `move only through set_channel_state(), which is what makes unlisting attributable.`,
          PLAN,
        ),
  );

  const guard = snap.triggers.find(
    (t) => t.table === "channels" && t.trigger === "channels_guard_state",
  );
  findings.push(
    guard && guard.timing === "BEFORE" && guard.events.includes("UPDATE")
      ? ok("unlist-guard-installed", "the sticky-unlist trigger is installed on channels", PLAN)
      : fail(
          "unlist-guard-installed",
          "the sticky-unlist trigger is installed on channels",
          guard
            ? `found as ${guard.timing} ${guard.events.join("/")} — expected BEFORE UPDATE`
            : "channels_guard_state is not installed. Nothing stops an ingest resurrecting an unlisted channel.",
          PLAN,
        ),
  );

  // -------------------------------------------------------------------------
  // is_short is derived by the database, at the ceiling the client gave us
  // -------------------------------------------------------------------------
  const isShort = snap.generatedColumns.find((c) => c.table === "videos" && c.column === "is_short");
  if (!isShort) {
    findings.push(
      fail(
        "is-short-generated",
        "videos.is_short is a generated column, not a value the ingest supplies",
        "not a generated column. Whatever wrote the row decided what a Short is.",
        PLAN,
      ),
    );
  } else {
    const usesFunction = isShort.expression.includes(`${AUDIT_SCHEMA}.short_max_seconds`);
    findings.push(
      usesFunction
        ? ok("is-short-generated", "videos.is_short is derived from short_max_seconds()", PLAN)
        : fail(
            "is-short-generated",
            "videos.is_short is derived from short_max_seconds()",
            `expression is ${isShort.expression} — a literal here drifts from ` +
              `SHORT_MAX_SECONDS_DEFAULT (${SHORT_MAX_SECONDS_DEFAULT}) without anything failing.`,
            PLAN,
          ),
    );
  }

  // -------------------------------------------------------------------------
  // The shared database is not carrying this tool's footprint in `public`
  // -------------------------------------------------------------------------
  findings.push(
    snap.objectsOutsideSchema.length === 0
      ? ok("no-public-footprint", `nothing this tool owns lives outside ${AUDIT_SCHEMA}`, SHARED)
      : fail(
          "no-public-footprint",
          `nothing this tool owns lives outside ${AUDIT_SCHEMA}`,
          snap.objectsOutsideSchema.map((o) => `${o.schema}.${o.name} (${o.kind})`).join(", ") +
            `. In a shared database that is either a stale pre-move object or a migration that ` +
            `never got re-homed; either way a co-tenant is now sharing a namespace with us.`,
          SHARED,
        ),
  );

  // -------------------------------------------------------------------------
  // PostgREST — a dashboard setting, and the one that looks like a bug
  // -------------------------------------------------------------------------
  findings.push(
    snap.exposedToPostgrest === null
      ? unknown(
          "postgrest-exposed",
          `PostgREST serves the ${AUDIT_SCHEMA} schema`,
          "could not be determined from this connection. Check Settings -> API -> Exposed schemas " +
            "by hand; add to the list, never replace it, or every co-tenant breaks.",
          SHARED,
        )
      : snap.exposedToPostgrest
        ? ok("postgrest-exposed", `PostgREST serves the ${AUDIT_SCHEMA} schema`, SHARED)
        : fail(
            "postgrest-exposed",
            `PostgREST serves the ${AUDIT_SCHEMA} schema`,
            `not exposed. Every query from the app returns PGRST106 and it looks like a broken ` +
              `build. Fix in Settings -> API -> Exposed schemas by ADDING ${AUDIT_SCHEMA} to the ` +
              `existing list.`,
            SHARED,
          ),
  );

  return findings;
}

/** True when nothing is failing. UNKNOWN is not a pass and is not a failure. */
export function isClean(findings: readonly Finding[]): boolean {
  return findings.every((f) => f.status !== "fail");
}

export function countBy(findings: readonly Finding[], status: Status): number {
  return findings.filter((f) => f.status === status).length;
}
