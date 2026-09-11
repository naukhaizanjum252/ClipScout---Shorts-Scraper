import { describe, expect, it } from "vitest";

import type { Platform } from "../platform/types";
import { shortKey } from "./store";
import { MemoryUsedShortsStore, type ShortRef } from "./used-store";

const ref = (platform: Platform, id: string): ShortRef => ({ platform, platform_video_id: id });

describe("MemoryUsedShortsStore", () => {
  it("starts with nothing marked", async () => {
    expect((await new MemoryUsedShortsStore().listUsedKeys()).size).toBe(0);
  });

  it("marks and unmarks by identity", async () => {
    const store = new MemoryUsedShortsStore();
    await store.setUsed(ref("youtube", "abc"), true);
    expect((await store.listUsedKeys()).has(shortKey(ref("youtube", "abc")))).toBe(true);

    await store.setUsed(ref("youtube", "abc"), false);
    expect((await store.listUsedKeys()).size).toBe(0);
  });

  it("keys on (platform, id), so the same id on two platforms does not collide", async () => {
    const store = new MemoryUsedShortsStore();
    await store.setUsed(ref("youtube", "abc"), true);
    await store.setUsed(ref("tiktok", "abc"), true);
    expect((await store.listUsedKeys()).size).toBe(2);
  });

  it("is idempotent in both directions", async () => {
    const store = new MemoryUsedShortsStore();
    await store.setUsed(ref("youtube", "abc"), true);
    await store.setUsed(ref("youtube", "abc"), true);
    expect((await store.listUsedKeys()).size).toBe(1);
    await store.setUsed(ref("youtube", "abc"), false);
    await store.setUsed(ref("youtube", "abc"), false);
    expect((await store.listUsedKeys()).size).toBe(0);
  });

  it("hands back a copy, so a caller cannot mutate the stored set", async () => {
    const store = new MemoryUsedShortsStore();
    await store.setUsed(ref("youtube", "abc"), true);
    (await store.listUsedKeys()).clear();
    expect((await store.listUsedKeys()).size).toBe(1);
  });
});
