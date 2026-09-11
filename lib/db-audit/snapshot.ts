/**
 * What a live database actually looks like, and the queries that read it.
 *
 * WHY THIS EXISTS
 *
 * `tests/migrations.test.ts` audits the migrations by reading the SQL. Its own
 * docstring is honest about the limit: it proves the migrations SAY the right
 * thing, not that a database IS in that state. Those are different claims, and
 * the gap between them is where the `impressions` finding lived — twelve of
 * fifteen functions were anon-callable while the design document said three.
 * Reading the design would never have found it. Reading `pg_proc.proacl` did.
 *
 * So this module defines the *shape* of a real database's answer, and
 * `audit.ts` turns that shape into findings. Neither of them opens a
 * connection: the split is what lets the whole audit run offline against
 * fixtures in `--selftest`, which is how we know the checks bite before we ever
 * point them at LookUp Media's database.
 *
 * EVERY QUERY HERE IS READ-ONLY. This runs against a database SHARED with other
 * projects (Erik, 2026-09-02, plan open question Q4), so `--check` must be safe
 * to run at any time, against production, by anybody. Nothing here writes, and
 * the behavioural proofs in `verify/db.ts --roundtrip` write only inside a
 * transaction that is always rolled back.
 */

/** The schema this tool owns. Mirrors DB_SCHEMA in lib/supabase/config.ts. */
export const AUDIT_SCHEMA = "shorts_scraper";

/** Roles that must never be able to reach anything in this schema. */
export const FORBIDDEN_ROLES = ["anon", "public", "PUBLIC"] as const;

export interface SchemaGrant {
  readonly grantee: string;
  readonly privilege: string;
}

export interface TableFact {
  readonly table: string;
  readonly rlsEnabled: boolean;
  readonly rlsForced: boolean;
}

export interface PolicyFact {
  readonly table: string;
  readonly policy: string;
  /** Empty means the policy has no `to` clause, i.e. it applies to PUBLIC. */
  readonly roles: readonly string[];
  readonly command: string;
}

export interface FunctionFact {
  readonly name: string;
  readonly identityArguments: string;
  readonly securityDefiner: boolean;
  /** `proconfig`, e.g. ["search_path=shorts_scraper, public"]. */
  readonly config: readonly string[];
  readonly grants: readonly SchemaGrant[];
}

export interface ColumnGrant {
  readonly table: string;
  readonly column: string;
  readonly grantee: string;
  readonly privilege: string;
}

export interface TableGrant {
  readonly table: string;
  readonly grantee: string;
  readonly privilege: string;
}

export interface TriggerFact {
  readonly table: string;
  readonly trigger: string;
  readonly timing: string;
  readonly events: readonly string[];
}

export interface GeneratedColumnFact {
  readonly table: string;
  readonly column: string;
  readonly expression: string;
}

export interface ForeignObjectFact {
  readonly schema: string;
  readonly kind: string;
  readonly name: string;
}

/** Everything the audit needs, in one plain object so it can be a fixture. */
export interface DbSnapshot {
  readonly schemaExists: boolean;
  readonly schemaGrants: readonly SchemaGrant[];
  readonly tables: readonly TableFact[];
  readonly policies: readonly PolicyFact[];
  readonly functions: readonly FunctionFact[];
  readonly tableGrants: readonly TableGrant[];
  readonly columnGrants: readonly ColumnGrant[];
  readonly triggers: readonly TriggerFact[];
  readonly generatedColumns: readonly GeneratedColumnFact[];
  /**
   * Objects this tool's migrations would have created in `public`. In a shared
   * database this must be empty; anything here is a cross-tenant footprint.
   */
  readonly objectsOutsideSchema: readonly ForeignObjectFact[];
  /** Whether PostgREST is serving this schema. Null when it could not be determined. */
  readonly exposedToPostgrest: boolean | null;
}

/**
 * The SQL. One statement per key, all read-only, all parameter-free so they can
 * be pasted into the SQL editor by a human who wants to check the checker.
 *
 * `has_schema_privilege` / `has_function_privilege` are used in preference to
 * parsing `aclitem` arrays because they answer the question that actually
 * matters — "can this role do it" — INCLUDING privileges inherited through role
 * membership, which reading `proacl` by hand silently misses.
 */
export const PROBES = {
  schemaExists: `
    select exists (
      select 1 from pg_namespace where nspname = '${AUDIT_SCHEMA}'
    ) as present;
  `,

  schemaGrants: `
    select r.rolname as grantee, 'USAGE' as privilege
    from pg_roles r
    where r.rolname in ('anon', 'authenticated', 'service_role')
      and has_schema_privilege(r.rolname, '${AUDIT_SCHEMA}', 'USAGE')
    union all
    select 'PUBLIC', 'USAGE'
    where has_schema_privilege('public', '${AUDIT_SCHEMA}', 'USAGE');
  `,

  tables: `
    select c.relname as table, c.relrowsecurity as rls_enabled, c.relforcerowsecurity as rls_forced
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = '${AUDIT_SCHEMA}' and c.relkind = 'r'
    order by c.relname;
  `,

  policies: `
    select tablename as table, policyname as policy, coalesce(roles, '{}') as roles, cmd as command
    from pg_policies
    where schemaname = '${AUDIT_SCHEMA}'
    order by tablename, policyname;
  `,

  functions: `
    select p.proname as name,
           pg_get_function_identity_arguments(p.oid) as identity_arguments,
           p.prosecdef as security_definer,
           coalesce(p.proconfig, '{}') as config
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = '${AUDIT_SCHEMA}'
    order by p.proname;
  `,

  /**
   * EXECUTE, asked as a capability rather than read off an ACL. This is the
   * `impressions` lesson mechanised: there are two grants (PUBLIC's and
   * Supabase's explicit `anon` one) and looking at either alone gives the wrong
   * answer.
   */
  functionGrants: `
    select p.proname as name,
           pg_get_function_identity_arguments(p.oid) as identity_arguments,
           g.grantee,
           'EXECUTE' as privilege
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    cross join (values ('anon'), ('authenticated'), ('service_role'), ('public')) as g(grantee)
    where n.nspname = '${AUDIT_SCHEMA}'
      and has_function_privilege(g.grantee, p.oid, 'EXECUTE')
    order by p.proname, g.grantee;
  `,

  tableGrants: `
    select c.relname as table, g.grantee, pr.privilege
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    cross join (values ('anon'), ('authenticated'), ('service_role'), ('public')) as g(grantee)
    cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) as pr(privilege)
    where n.nspname = '${AUDIT_SCHEMA}' and c.relkind = 'r'
      and has_table_privilege(g.grantee, c.oid, pr.privilege)
    order by c.relname, g.grantee, pr.privilege;
  `,

  /**
   * Column-level SELECT, which is how `secret_ciphertext` is kept away from an
   * admin's browser session. `has_table_privilege` returns true if ANY column is
   * readable, so the table-level probe above cannot answer this.
   */
  columnGrants: `
    select c.relname as table, a.attname as column, g.grantee, 'SELECT' as privilege
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
    cross join (values ('anon'), ('authenticated'), ('service_role'), ('public')) as g(grantee)
    where n.nspname = '${AUDIT_SCHEMA}' and c.relkind = 'r'
      and has_column_privilege(g.grantee, c.oid, a.attname, 'SELECT')
    order by c.relname, a.attname, g.grantee;
  `,

  triggers: `
    select c.relname as table,
           t.tgname as trigger,
           case when (t.tgtype & 2) <> 0 then 'BEFORE' else 'AFTER' end as timing,
           array_remove(array[
             case when (t.tgtype &  4) <> 0 then 'INSERT' end,
             case when (t.tgtype &  8) <> 0 then 'DELETE' end,
             case when (t.tgtype & 16) <> 0 then 'UPDATE' end
           ], null) as events
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = '${AUDIT_SCHEMA}' and not t.tgisinternal
    order by c.relname, t.tgname;
  `,

  generatedColumns: `
    select c.relname as table, a.attname as column, pg_get_expr(d.adbin, d.adrelid) as expression
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
    join pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum
    where n.nspname = '${AUDIT_SCHEMA}' and a.attgenerated <> ''
    order by c.relname, a.attname;
  `,

  /**
   * The cross-tenant footprint check.
   *
   * Names this tool's migrations would have created, looked for in `public`
   * rather than in its own schema. In a shared database a hit here means this
   * repo has put something in a namespace it does not own — which is the same
   * failure that `revoke all ... in schema public` would have been, only
   * quieter.
   */
  objectsOutsideSchema: `
    select n.nspname as schema, 'table' as kind, c.relname as name
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and c.relname in ('channels', 'videos', 'channel_sources', 'runs',
                        'profiles', 'api_credentials', 'credential_quota_days')
    union all
    select n.nspname, 'function', p.proname
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('short_max_seconds', 'role_of', 'is_admin', 'can_read',
                        'set_channel_state', 'guard_automated_channel_state',
                        'lease_api_credential', 'record_credential_units')
    union all
    select n.nspname, 'type', t.typname
    from pg_type t join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public'
      and t.typname in ('channel_state', 'run_kind', 'app_role',
                        'credential_provider', 'credential_status');
  `,

  /**
   * Whether PostgREST is serving this schema.
   *
   * Supabase stores it as a database setting on the `authenticator` role. If
   * this comes back without `shorts_scraper`, every request from the app
   * returns PGRST106 and the cause is a dashboard setting, not the migrations —
   * a distinction worth reporting by name because it looks like a broken build.
   */
  exposedToPostgrest: `
    select coalesce(
      (select array_to_string(setconfig, ' ')
       from pg_db_role_setting s
       join pg_roles r on r.oid = s.setrole
       where r.rolname = 'authenticator'),
      ''
    ) as settings;
  `,
} as const;

export type ProbeName = keyof typeof PROBES;
