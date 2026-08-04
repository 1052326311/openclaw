import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { listSessionEntries, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { beginSessionWorkAdmission } from "../sessions/session-lifecycle-admission.js";
import { setupCronServiceSuite } from "./service.test-harness.js";
import { remove } from "./service/ops-mutations.js";
import { createCronServiceState } from "./service/state.js";
import { loadCronStore, saveCronStore } from "./store.js";
import type { CronJob } from "./types.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-remove-session-cleanup-",
  baseTimeIso: "2026-08-04T00:00:00.000Z",
});

function createJob(params: {
  id: string;
  agentId?: string;
  sessionTarget?: CronJob["sessionTarget"];
}): CronJob {
  const now = Date.now();
  return {
    id: params.id,
    name: params.id,
    enabled: true,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    createdAtMs: now,
    updatedAtMs: now,
    schedule: { kind: "every", everyMs: 60_000, anchorMs: now },
    sessionTarget: params.sessionTarget ?? "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "test" },
    delivery: { mode: "none" },
    state: { nextRunAtMs: now + 60_000 },
  };
}

function createState(params: {
  cronStorePath: string;
  sessionStorePath: string;
  resolveSessionStorePath?: (agentId?: string) => string;
}) {
  return createCronServiceState({
    storePath: params.cronStorePath,
    cronEnabled: true,
    log: logger,
    nowMs: () => Date.now(),
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(),
    defaultAgentId: "main",
    sessionStorePath: params.sessionStorePath,
    ...(params.resolveSessionStorePath
      ? { resolveSessionStorePath: params.resolveSessionStorePath }
      : {}),
  });
}

async function seedSession(params: {
  agentId: string;
  storePath: string;
  sessionKey: string;
  sessionId: string;
}) {
  await replaceSessionEntry(
    {
      agentId: params.agentId,
      storePath: params.storePath,
      sessionKey: params.sessionKey,
    },
    {
      sessionId: params.sessionId,
      lifecycleRevision: `${params.sessionId}-revision`,
      updatedAt: Date.now(),
    },
  );
}

describe("cron.remove session cleanup", () => {
  it("removes only the deleted isolated job's canonical base session", async () => {
    const { storePath } = await makeStorePath();
    const sessionStorePath = path.join(path.dirname(storePath), "sessions", "sessions.json");
    const job = createJob({ id: "deleted-job" });
    await saveCronStore(storePath, { version: 1, jobs: [job] });
    await seedSession({
      agentId: "main",
      storePath: sessionStorePath,
      sessionKey: "agent:main:cron:deleted-job",
      sessionId: "deleted-base",
    });
    await seedSession({
      agentId: "main",
      storePath: sessionStorePath,
      sessionKey: "agent:main:cron:deleted-job:run:retained-run",
      sessionId: "retained-run",
    });
    await seedSession({
      agentId: "main",
      storePath: sessionStorePath,
      sessionKey: "agent:main:cron:other-job",
      sessionId: "other-base",
    });
    const state = createState({ cronStorePath: storePath, sessionStorePath });

    await expect(remove(state, job.id)).resolves.toEqual({ ok: true, removed: true });

    await expect(loadCronStore(storePath)).resolves.toMatchObject({ jobs: [] });
    expect(
      listSessionEntries({ agentId: "main", storePath: sessionStorePath }).map(
        ({ sessionKey }) => sessionKey,
      ),
    ).toEqual(["agent:main:cron:deleted-job:run:retained-run", "agent:main:cron:other-job"]);
  });

  it("resolves the deleted job owner's session store", async () => {
    const { storePath } = await makeStorePath();
    const defaultStorePath = path.join(path.dirname(storePath), "main", "sessions.json");
    const workerStorePath = path.join(path.dirname(storePath), "worker", "sessions.json");
    const job = createJob({ id: "worker-job", agentId: "worker" });
    await saveCronStore(storePath, { version: 1, jobs: [job] });
    await seedSession({
      agentId: "worker",
      storePath: workerStorePath,
      sessionKey: "agent:worker:cron:worker-job",
      sessionId: "worker-base",
    });
    const resolveSessionStorePath = vi.fn((agentId?: string) =>
      agentId === "worker" ? workerStorePath : defaultStorePath,
    );
    const state = createState({
      cronStorePath: storePath,
      sessionStorePath: defaultStorePath,
      resolveSessionStorePath,
    });

    await expect(remove(state, job.id)).resolves.toEqual({ ok: true, removed: true });

    expect(resolveSessionStorePath).toHaveBeenCalledWith("worker");
    expect(listSessionEntries({ agentId: "worker", storePath: workerStorePath })).toEqual([]);
  });

  it("keeps the durable job deletion when session cleanup fails", async () => {
    const { storePath } = await makeStorePath();
    const sessionStorePath = path.join(path.dirname(storePath), "sessions", "sessions.json");
    const job = createJob({ id: "cleanup-failure" });
    await saveCronStore(storePath, { version: 1, jobs: [job] });
    const state = createState({
      cronStorePath: storePath,
      sessionStorePath,
      resolveSessionStorePath: () => {
        throw new Error("session store unavailable");
      },
    });

    await expect(remove(state, job.id)).resolves.toEqual({ ok: true, removed: true });

    await expect(loadCronStore(storePath)).resolves.toMatchObject({ jobs: [] });
    expect(logger.warn).toHaveBeenCalledWith(
      { jobId: job.id, err: "session store unavailable" },
      "cron: session cleanup failed",
    );
  });

  it("preserves shared main-session targets", async () => {
    const { storePath } = await makeStorePath();
    const sessionStorePath = path.join(path.dirname(storePath), "sessions", "sessions.json");
    const job = createJob({ id: "main-target", sessionTarget: "main" });
    await saveCronStore(storePath, { version: 1, jobs: [job] });
    await seedSession({
      agentId: "main",
      storePath: sessionStorePath,
      sessionKey: "agent:main:main",
      sessionId: "main-session",
    });
    const state = createState({ cronStorePath: storePath, sessionStorePath });

    await expect(remove(state, job.id)).resolves.toEqual({ ok: true, removed: true });

    expect(listSessionEntries({ agentId: "main", storePath: sessionStorePath })).toEqual([
      expect.objectContaining({ sessionKey: "agent:main:main" }),
    ]);
  });

  it("waits for admitted work before deleting the base session", async () => {
    vi.useRealTimers();
    const { storePath } = await makeStorePath();
    const sessionStorePath = path.join(path.dirname(storePath), "sessions", "sessions.json");
    const job = createJob({ id: "active-job" });
    const sessionKey = "agent:main:cron:active-job";
    await saveCronStore(storePath, { version: 1, jobs: [job] });
    await seedSession({
      agentId: "main",
      storePath: sessionStorePath,
      sessionKey,
      sessionId: "active-base",
    });
    const admission = await beginSessionWorkAdmission({
      scope: sessionStorePath,
      identities: [sessionKey, "active-base"],
      assertAllowed: () => {},
    });
    const state = createState({ cronStorePath: storePath, sessionStorePath });

    await expect(remove(state, job.id)).resolves.toEqual({ ok: true, removed: true });
    expect(listSessionEntries({ agentId: "main", storePath: sessionStorePath })).toHaveLength(1);

    admission.release();
    await vi.waitFor(() => {
      expect(listSessionEntries({ agentId: "main", storePath: sessionStorePath })).toEqual([]);
    });
  });

  it("keeps a replacement generation created before deferred cleanup", async () => {
    vi.useRealTimers();
    const { storePath } = await makeStorePath();
    const sessionStorePath = path.join(path.dirname(storePath), "sessions", "sessions.json");
    const job = createJob({ id: "replaced-job" });
    const sessionKey = "agent:main:cron:replaced-job";
    await saveCronStore(storePath, { version: 1, jobs: [job] });
    await seedSession({
      agentId: "main",
      storePath: sessionStorePath,
      sessionKey,
      sessionId: "old-base",
    });
    const admission = await beginSessionWorkAdmission({
      scope: sessionStorePath,
      identities: [sessionKey, "old-base"],
      assertAllowed: () => {},
    });
    const state = createState({ cronStorePath: storePath, sessionStorePath });
    await expect(remove(state, job.id)).resolves.toEqual({ ok: true, removed: true });

    await seedSession({
      agentId: "main",
      storePath: sessionStorePath,
      sessionKey,
      sessionId: "replacement-base",
    });
    admission.release();

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 25);
    });
    expect(listSessionEntries({ agentId: "main", storePath: sessionStorePath })).toEqual([
      expect.objectContaining({
        sessionKey,
        entry: expect.objectContaining({ sessionId: "replacement-base" }),
      }),
    ]);
  });
});
