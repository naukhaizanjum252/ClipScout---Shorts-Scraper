/**
 * What a correctly migrated database looks like, written down.
 *
 * This is the expected answer, not a recording of a real one — no database has
 * been migrated yet, and inventing an observation is exactly what this repo
 * refuses to do (see verify/fixtures/README.md). Its job is narrower and
 * honest: it is the input `--selftest` mutates, so that every check in
 * `audit.ts` is proven to go RED when the thing it guards is broken.
 *
 * A check that has never failed is not a check. Keeping the healthy shape here
 * and the mutations next to it is what stops this audit shipping as a row of
 * green ticks nobody has tested.
 */
import { AUDIT_SCHEMA, type DbSnapshot, type FunctionFact, type PolicyFact } from "./snapshot";

function policy(table: string, name: string, command: string, roles: string[] = ["authenticated"]): PolicyFact {
  return { table, policy: name, command, roles };
}

function fn(
  name: string,
  identityArguments: string,
  securityDefiner: boolean,
  grantees: string[],
): FunctionFact {
  return {
    name,
    identityArguments,
    securityDefiner,
    config: securityDefiner ? [`search_path=${AUDIT_SCHEMA}, public`] : [],
    grants: grantees.map((grantee) => ({ grantee, privilege: "EXECUTE" })),
  };
}

/** The state the five migrations in supabase/migrations/ are meant to produce. */
export function healthySnapshot(): DbSnapshot {
  return {
    schemaExists: true,

    // anon is absent on purpose. That is the outermost door.
    schemaGrants: [
      { grantee: "authenticated", privilege: "USAGE" },
      { grantee: "service_role", privilege: "USAGE" },
    ],

    tables: [
      "profiles",
      "channels",
      "videos",
      "channel_sources",
      "runs",
      "api_credentials",
      "credential_quota_days",
    ].map((table) => ({ table, rlsEnabled: true, rlsForced: false })),

    policies: [
      policy("profiles", "profiles: read own", "SELECT"),
      policy("profiles", "profiles: admins read all", "SELECT"),
      policy("profiles", "profiles: update own name", "UPDATE"),
      policy("channels", "channels: members read", "SELECT"),
      policy("channels", "channels: admins insert", "INSERT"),
      policy("channels", "channels: admins delete", "DELETE"),
      policy("videos", "videos: members read", "SELECT"),
      policy("videos", "videos: admins write", "INSERT"),
      policy("videos", "videos: admins update", "UPDATE"),
      policy("videos", "videos: admins delete", "DELETE"),
      policy("channel_sources", "channel_sources: members read", "SELECT"),
      policy("channel_sources", "channel_sources: admins insert", "INSERT"),
      policy("runs", "runs: members read", "SELECT"),
      policy("runs", "runs: admins insert", "INSERT"),
      policy("runs", "runs: admins update", "UPDATE"),
      policy("api_credentials", "api_credentials: admins read", "SELECT"),
      policy("api_credentials", "api_credentials: admins insert", "INSERT"),
      policy("api_credentials", "api_credentials: admins delete", "DELETE"),
      policy("credential_quota_days", "credential_quota_days: members read", "SELECT"),
    ],

    functions: [
      fn("short_max_seconds", "", false, []),
      fn("role_of", "", true, ["authenticated"]),
      fn("is_admin", "", true, ["authenticated"]),
      fn("can_read", "", true, ["authenticated"]),
      fn("guard_automated_channel_state", "", true, []),
      fn("set_channel_state", `p_channel_id text, p_state ${AUDIT_SCHEMA}.channel_state, p_reason text`, true, [
        "authenticated",
      ]),
      fn("lease_api_credential", `p_provider ${AUDIT_SCHEMA}.credential_provider`, true, ["service_role"]),
      fn("record_credential_units", "p_credential_id uuid, p_units integer, p_on date", true, ["service_role"]),
    ],

    // Migration 06. `public` would have handed these out by default; a
    // schema that is not `public` gets none of them, and the failure reads as
    // "permission denied for table channels" rather than as zero rows.
    tableGrants: [
      ...(
        [
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
        ] as [string, string, string[]][]
      ).flatMap(([table, grantee, privileges]) =>
        privileges.map((privilege) => ({ table, grantee, privilege })),
      ),
    ],

    // The only entry that matters is the one that is NOT here:
    // api_credentials.secret_ciphertext readable by anon or authenticated.
    columnGrants: [
      { table: "api_credentials", column: "masked", grantee: "authenticated", privilege: "SELECT" },
      { table: "api_credentials", column: "secret_ciphertext", grantee: "service_role", privilege: "SELECT" },
    ],

    triggers: [{ table: "channels", trigger: "channels_guard_state", timing: "BEFORE", events: ["UPDATE"] }],

    generatedColumns: [
      {
        table: "videos",
        column: "is_short",
        expression: `(duration_seconds IS NOT NULL AND duration_seconds <= ${AUDIT_SCHEMA}.short_max_seconds())`,
      },
    ],

    objectsOutsideSchema: [],

    exposedToPostgrest: true,
  };
}

/**
 * The mutations. Each one is a real failure mode with a name, and each is
 * asserted to turn a specific finding red.
 *
 * Several of them are drawn from things that have actually happened rather than
 * things that could: `anon-execute` is the `impressions` audit finding, and
 * `public-footprint` is the cross-tenant footgun that the first draft of
 * migration 05 shipped with.
 */
export const MUTATIONS: ReadonlyArray<{
  readonly name: string;
  readonly expectFailure: string;
  readonly why: string;
  readonly apply: (s: DbSnapshot) => DbSnapshot;
}> = [
  {
    name: "schema-missing",
    expectFailure: "schema-exists",
    why: "migrations never applied — every other check would otherwise pass vacuously",
    apply: (s) => ({ ...s, schemaExists: false }),
  },
  {
    name: "anon-schema-usage",
    expectFailure: "anon-no-schema-usage",
    why: "PostgREST connects as anon; schema USAGE is the outermost door",
    apply: (s) => ({ ...s, schemaGrants: [...s.schemaGrants, { grantee: "anon", privilege: "USAGE" }] }),
  },
  {
    name: "authenticated-locked-out",
    expectFailure: "authenticated-schema-usage",
    why: "looks like a broken build rather than a missing grant",
    apply: (s) => ({ ...s, schemaGrants: s.schemaGrants.filter((g) => g.grantee !== "authenticated") }),
  },
  {
    name: "rls-off-on-one-table",
    expectFailure: "rls-everywhere",
    why: "one table without RLS is the whole inventory readable",
    apply: (s) => ({
      ...s,
      tables: s.tables.map((t) => (t.table === "videos" ? { ...t, rlsEnabled: false } : t)),
    }),
  },
  {
    name: "policy-with-no-to-clause",
    expectFailure: "no-anon-policy",
    why: "a policy with no `to` applies to PUBLIC, which includes anon — the silent version",
    apply: (s) => ({ ...s, policies: [...s.policies, policy("channels", "oops", "SELECT", [])] }),
  },
  {
    name: "anon-execute",
    expectFailure: "no-anon-execute",
    why: "the impressions finding: twelve of fifteen functions anon-callable",
    apply: (s) => ({
      ...s,
      functions: s.functions.map((f) =>
        f.name === "can_read" ? { ...f, grants: [...f.grants, { grantee: "anon", privilege: "EXECUTE" }] } : f,
      ),
    }),
  },
  {
    name: "definer-without-pinned-search-path",
    expectFailure: "definer-search-path",
    why: "in a shared database a co-tenant can put their table earlier on the path",
    apply: (s) => ({
      ...s,
      functions: s.functions.map((f) => (f.name === "set_channel_state" ? { ...f, config: [] } : f)),
    }),
  },
  {
    name: "ciphertext-readable-by-admin-session",
    expectFailure: "ciphertext-unreadable",
    why: "an admin's browser session could then fetch every operator's sealed key",
    apply: (s) => ({
      ...s,
      columnGrants: [
        ...s.columnGrants,
        { table: "api_credentials", column: "secret_ciphertext", grantee: "authenticated", privilege: "SELECT" },
      ],
    }),
  },
  {
    name: "lease-callable-by-authenticated",
    expectFailure: "lease-service-role-only",
    why: "the only path in the system that yields a plaintext API key",
    apply: (s) => ({
      ...s,
      functions: s.functions.map((f) =>
        f.name === "lease_api_credential"
          ? { ...f, grants: [...f.grants, { grantee: "authenticated", privilege: "EXECUTE" }] }
          : f,
      ),
    }),
  },
  {
    name: "channels-update-policy-added",
    expectFailure: "channels-no-update-policy",
    why: "state would move without going through set_channel_state, so unlisting stops being attributable",
    apply: (s) => ({ ...s, policies: [...s.policies, policy("channels", "channels: admins update", "UPDATE")] }),
  },
  {
    name: "unlist-guard-dropped",
    expectFailure: "unlist-guard-installed",
    why: "the client's whole mechanism is that an unlisted channel stays unlisted",
    apply: (s) => ({ ...s, triggers: s.triggers.filter((t) => t.trigger !== "channels_guard_state") }),
  },
  {
    name: "is-short-hardcoded",
    expectFailure: "is-short-generated",
    why: "a literal drifts from SHORT_MAX_SECONDS_DEFAULT without anything failing",
    apply: (s) => ({
      ...s,
      generatedColumns: s.generatedColumns.map((c) =>
        c.column === "is_short" ? { ...c, expression: "(duration_seconds <= 60)" } : c,
      ),
    }),
  },
  {
    name: "public-footprint",
    expectFailure: "no-public-footprint",
    why: "the cross-tenant footgun the first draft of migration 05 shipped with",
    apply: (s) => ({
      ...s,
      objectsOutsideSchema: [{ schema: "public", kind: "table", name: "channels" }],
    }),
  },
  {
    name: "grants-lost-with-the-schema-move",
    expectFailure: "grants-present",
    why: "moving off `public` loses Supabase's default grants; reads as permission denied, not zero rows",
    apply: (s) => ({ ...s, tableGrants: s.tableGrants.filter((g) => g.table !== "channels") }),
  },
  {
    name: "anon-table-grant",
    expectFailure: "no-anon-table-grant",
    why: "a grant survives somebody adding a permissive policy; a policy does not survive a missing grant",
    apply: (s) => ({
      ...s,
      tableGrants: [...s.tableGrants, { table: "channels", grantee: "anon", privilege: "SELECT" }],
    }),
  },
  {
    name: "session-can-update-channels",
    expectFailure: "no-session-update-on-channels",
    why: "with UPDATE granted, one added policy is enough to move state outside set_channel_state()",
    apply: (s) => ({
      ...s,
      tableGrants: [...s.tableGrants, { table: "channels", grantee: "authenticated", privilege: "UPDATE" }],
    }),
  },
  {
    name: "schema-not-exposed",
    expectFailure: "postgrest-exposed",
    why: "every app query returns PGRST106 and it reads as a broken build",
    apply: (s) => ({ ...s, exposedToPostgrest: false }),
  },
];
