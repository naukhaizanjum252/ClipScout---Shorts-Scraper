import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { check, main, quotaDir, recordingPath, reportPath, selftest } from "../verify/quota";

/**
 * The harness, verified from inside the test suite as well as from the CLI.
 *
 * `--selftest` is the thing the plan's acceptance names, and it must pass with
 * NO API key and NO network. Vitest gives no network here anyway, and the
 * environment is emptied of the key below so the assertion is real rather than
 * incidental.
 */

function withoutKey<T>(fn: () => T): T {
  const saved = { ...process.env };
  delete process.env.YOUTUBE_API_KEY;
  delete process.env.YOUTUBE_DAILY_QUOTA_UNITS;
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  try {
    return fn();
  } finally {
    process.env = saved;
  }
}

describe("verify/quota.ts --selftest", () => {
  it("passes with no API key set", async () => {
    await withoutKey(async () => {
      await expect(selftest()).resolves.toBeUndefined();
    });
  });

  it("exits 0 through main()", async () => {
    await withoutKey(async () => {
      await expect(main(["--selftest"])).resolves.toBe(0);
    });
  });
});

describe("verify/quota.ts --check", () => {
  it("is INERT on the keyless path, and says so rather than silently passing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quota-t-"));
    try {
      const outcome = check(dir, { strict: false, adapter: "ytdlp" });
      expect(outcome.ok).toBe(true);
      expect(outcome.inert).toBe(true);
      expect(outcome.problems.join(" ")).toMatch(/keyless path spends no API quota/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is RED under --strict, because nothing has been measured", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quota-t-"));
    try {
      const outcome = check(dir, { strict: true, adapter: "api" });
      expect(outcome.ok).toBe(false);
      expect(outcome.problems.join(" ")).toMatch(/nothing has been measured/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the committed state of verify/fixtures", () => {
  /**
   * THE HONEST RED.
   *
   * Phase 0's acceptance wants `verify/fixtures/quota.json` to hold an OBSERVED
   * unit cost for all four operations. It does not, because no API key exists
   * for this project and the API does not report what a call cost. Rather than
   * leave that as an absence somebody might mistake for an oversight, the
   * fixtures directory carries a README saying so, and this test asserts that
   * the recording is genuinely absent — so the day somebody adds one, this test
   * fails and forces the README and the plan's phase_state to be updated with it.
   */
  it("has no recording yet, and the placeholder says why", () => {
    const dir = quotaDir();
    expect(fs.existsSync(recordingPath(dir))).toBe(false);
    expect(fs.existsSync(reportPath(dir))).toBe(false);

    const readme = fs.readFileSync(path.join(dir, "README.md"), "utf8");
    expect(readme).toMatch(/UNRECORDED/);
    expect(readme).toMatch(/--calibrate|--observe/);
  });
});
