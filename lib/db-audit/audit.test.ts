import { describe, expect, it } from "vitest";

import { auditSnapshot, countBy, isClean } from "./audit";
import { MUTATIONS, healthySnapshot } from "./fixtures";
import { AUDIT_SCHEMA, PROBES } from "./snapshot";

describe("the live-database audit", () => {
  it("passes a correctly migrated database", () => {
    const findings = auditSnapshot(healthySnapshot());
    const failures = findings.filter((f) => f.status === "fail");
    expect(failures.map((f) => `${f.id}: ${f.detail}`)).toEqual([]);
    expect(isClean(findings)).toBe(true);
    expect(countBy(findings, "unknown")).toBe(0);
  });

  it("reports every check by a stable, unique id", () => {
    const ids = auditSnapshot(healthySnapshot()).map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  /**
   * THE POINT OF THE WHOLE FILE.
   *
   * An audit nobody has broken on purpose is a row of green ticks. Each
   * mutation is a failure mode that has either happened before (the
   * `impressions` anon-EXECUTE finding, the cross-tenant `public` footprint) or
   * would be invisible until it mattered.
   */
  describe("every check bites", () => {
    for (const mutation of MUTATIONS) {
      it(`${mutation.name} turns ${mutation.expectFailure} red — ${mutation.why}`, () => {
        const findings = auditSnapshot(mutation.apply(healthySnapshot()));
        const target = findings.find((f) => f.id === mutation.expectFailure);
        expect(target, `${mutation.expectFailure} was not reported at all`).toBeDefined();
        expect(target?.status, `${mutation.expectFailure}: ${target?.detail}`).toBe("fail");
        expect(isClean(findings)).toBe(false);
        // A failing check has to say what it saw, or the report is useless at
        // 2am when somebody is trying to work out which grant is wrong.
        expect(target?.detail.length ?? 0).toBeGreaterThan(0);
      });
    }
  });

  it("refuses to grade a database the migrations were never applied to", () => {
    // The dangerous case: every "no anon policy" style check passes trivially
    // when there are no policies, so an empty database must not read as clean.
    const findings = auditSnapshot({ ...healthySnapshot(), schemaExists: false });
    expect(findings).toHaveLength(1);
    expect(findings[0].id).toBe("schema-exists");
    expect(isClean(findings)).toBe(false);
  });

  it("treats an undeterminable check as unknown, never as a pass", () => {
    const findings = auditSnapshot({ ...healthySnapshot(), exposedToPostgrest: null });
    const postgrest = findings.find((f) => f.id === "postgrest-exposed");
    expect(postgrest?.status).toBe("unknown");
    // Unknown is not a failure either — it is the third state, and the runner
    // prints it separately so "did not run" cannot be read as "passed".
    expect(isClean(findings)).toBe(true);
    expect(countBy(findings, "unknown")).toBe(1);
  });
});

describe("the probes are safe to run against a shared production database", () => {
  it("contains no statement that writes", () => {
    for (const [name, sql] of Object.entries(PROBES)) {
      expect(sql.toLowerCase(), name).not.toMatch(
        /\b(insert|update|delete|drop|create|alter|truncate|grant|revoke)\s/,
      );
    }
  });

  it("reads only this tool's schema, plus the `public` footprint check", () => {
    for (const [name, sql] of Object.entries(PROBES)) {
      if (name === "objectsOutsideSchema" || name === "exposedToPostgrest") continue;
      expect(sql, name).toContain(AUDIT_SCHEMA);
    }
  });
});
