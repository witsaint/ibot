/**
 * JobManager lifecycle bookkeeping we can test without running a model: reclaiming orphaned
 * `running` rows at boot, and cancel being a safe no-op for a job not running in this process.
 * (The detached run itself is exercised end-to-end by the API verify script.)
 */
import type { Database } from "@i-bot/db";
import type { Logger } from "@i-bot/logger";
import { describe, expect, it, vi } from "vitest";
import type { ConversationEventBus } from "../events/bus.js";
import { JobManager } from "./jobs.js";
import type { SandboxManager } from "../sandbox/manager.js";

function fakeLogger(): Logger {
  const l = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, child: () => l };
  return l as unknown as Logger;
}

/** An inert event bus — publish/subscribe are no-ops for the lifecycle-only tests here. */
function fakeEvents(): ConversationEventBus {
  return {
    publish: () => {},
    subscribe: () => () => {},
    listenerCount: () => 0,
  } as unknown as ConversationEventBus;
}

/** A db whose agentJobs query returns `orphans` and whose update() records the patch applied. */
function fakeDb(orphans: { id: string }[]) {
  const updates: Record<string, unknown>[] = [];
  const db = {
    query: { agentJobs: { findMany: async () => orphans } },
    update: () => ({
      set: (patch: Record<string, unknown>) => {
        updates.push(patch);
        return { where: async () => undefined };
      },
    }),
  } as unknown as Database;
  return { db, updates };
}

describe("JobManager.reclaimOrphans", () => {
  it("flips orphaned running jobs to error at boot", async () => {
    const { db, updates } = fakeDb([{ id: "j1" }, { id: "j2" }]);
    const jobs = new JobManager({
      db,
      logger: fakeLogger(),
      sandboxes: {} as SandboxManager,
      events: fakeEvents(),
    });

    await jobs.reclaimOrphans();

    expect(updates).toHaveLength(1);
    const patch = updates[0]!;
    expect(patch.status).toBe("error");
    expect(patch.error).toMatch(/restart/i);
    expect(patch.finishedAt).toBeInstanceOf(Date);
  });

  it("does nothing when there are no running jobs", async () => {
    const { db, updates } = fakeDb([]);
    const jobs = new JobManager({
      db,
      logger: fakeLogger(),
      sandboxes: {} as SandboxManager,
      events: fakeEvents(),
    });

    await jobs.reclaimOrphans();
    expect(updates).toHaveLength(0);
  });
});

describe("JobManager.cancel", () => {
  it("returns false for a task not running in this process (no throw)", () => {
    const { db } = fakeDb([]);
    const jobs = new JobManager({
      db,
      logger: fakeLogger(),
      sandboxes: {} as SandboxManager,
      events: fakeEvents(),
    });
    expect(jobs.cancel("nope")).toBe(false);
  });

  it("does not touch the task registry for a task it never held", () => {
    const { db } = fakeDb([]);
    const unregisterTask = vi.fn();
    const jobs = new JobManager({
      db,
      logger: fakeLogger(),
      sandboxes: { unregisterTask } as unknown as SandboxManager,
      events: fakeEvents(),
    });
    jobs.cancel("nope");
    expect(unregisterTask).not.toHaveBeenCalled();
  });
});
