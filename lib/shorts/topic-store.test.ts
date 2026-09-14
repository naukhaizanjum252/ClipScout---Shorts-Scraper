/**
 * The store's two refusals and its one non-destructive write.
 *
 * Everything else here is bookkeeping. The tests worth having are the ones
 * about what CANNOT be done: a duplicate address cannot be created, a topic
 * cannot be emptied of its terms, and "restore the plan" cannot undo somebody's
 * edits.
 */
import { describe, expect, it } from "vitest";

import { MemoryTopicStore, TopicStoreError, activeTopics, resolveTopicStore } from "./topic-store";
import { planTopics } from "./topics";

const AT = () => new Date("2026-09-05T00:00:00.000Z");

describe("MemoryTopicStore", () => {
  it("adds a topic and addresses it by its slug", async () => {
    const store = new MemoryTopicStore([], { now: AT });
    const topic = await store.addTopic({ name: "Shark Tank", terms: ["shark tank"] });
    expect(topic.slug).toBe("shark-tank");
    expect(topic.source).toBe("manual");
  });

  it("refuses a second topic with the same address", async () => {
    const store = new MemoryTopicStore([], { now: AT });
    await store.addTopic({ name: "Shark Tank", terms: ["a"] });
    await expect(store.addTopic({ name: "shark tank!", terms: ["b"] })).rejects.toBeInstanceOf(
      TopicStoreError,
    );
  });

  it("refuses a topic with no terms", async () => {
    const store = new MemoryTopicStore([], { now: AT });
    await expect(store.addTopic({ name: "Empty", terms: [] })).rejects.toThrow(
      /at least one search term/i,
    );
  });

  it("switching off keeps the row and its terms", async () => {
    const store = new MemoryTopicStore([], { now: AT });
    await store.addTopic({ name: "Shark Tank", terms: ["shark tank"] });
    const off = await store.setTopicActive("shark-tank", false);
    expect(off.active).toBe(false);
    expect(off.terms).toEqual(["shark tank"]);
    expect((await store.listTopics()).length).toBe(1);
  });

  it("says which topic was not found rather than silently doing nothing", async () => {
    const store = new MemoryTopicStore([], { now: AT });
    await expect(store.setTopicActive("nope", false)).rejects.toThrow(/no topic addressed as/i);
  });

  it("restores only the plan topics that are missing", async () => {
    const store = new MemoryTopicStore([], { now: AT });
    await store.addTopic({ name: "Shark Tank", terms: ["my own terms"] });
    await store.setTopicActive("shark-tank", false);

    const written = await store.seedPlanTopics();

    expect(written.length).toBe(29);
    expect(written.some((t) => t.slug === "shark-tank")).toBe(false);

    // The edited, switched-off one is exactly as it was left.
    const mine = (await store.listTopics()).find((t) => t.slug === "shark-tank")!;
    expect(mine.terms).toEqual(["my own terms"]);
    expect(mine.active).toBe(false);
  });

  it("deletes a topic outright, and deleting an absent one is a no-op", async () => {
    const store = new MemoryTopicStore([], { now: AT });
    await store.addTopic({ name: "Shark Tank", terms: ["shark tank"] });
    await store.addTopic({ name: "AGT", terms: ["agt"] });

    await store.deleteTopic("shark-tank");
    expect((await store.listTopics()).map((t) => t.slug)).toEqual(["agt"]);

    // A slug that is not there deletes nothing and does not throw.
    await expect(store.deleteTopic("never-existed")).resolves.toBeUndefined();
    expect((await store.listTopics()).length).toBe(1);
  });

  it("refuses every write when it is read-only", async () => {
    const store = new MemoryTopicStore(planTopics(AT), { readOnlyReason: "no database", now: AT });
    await expect(store.addTopic({ name: "X", terms: ["x"] })).rejects.toThrow("no database");
    await expect(store.setTopicActive("shark-tank", false)).rejects.toThrow("no database");
    await expect(store.deleteTopic("shark-tank")).rejects.toThrow("no database");
    // Reading still works, which is the point of the fallback.
    expect((await store.listTopics()).length).toBe(30);
  });
});

describe("activeTopics", () => {
  it("drops the inactive ones and the ones with no terms", () => {
    const [a, b, c] = planTopics(AT);
    const list = activeTopics([a, { ...b, active: false }, { ...c, terms: [] }]);
    expect(list.map((t) => t.slug)).toEqual([a.slug]);
  });
});

describe("resolveTopicStore", () => {
  it("falls back to the plan's list, read-only, with no database", async () => {
    const resolved = await resolveTopicStore({ databaseConfigured: false, now: AT });
    expect(resolved.origin).toBe("plan");
    expect(resolved.store.readOnlyReason).toMatch(/read-only/i);
    expect((await resolved.store.listTopics()).length).toBe(30);
  });
});
