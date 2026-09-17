import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import {
  startServer,
  stopServer,
  tusCreate,
  TEST_TOKEN,
  UPLOAD_PATH,
  rawRequest,
} from "./helpers.js";
import type { TestContext, RawResponse } from "./helpers.js";
import { FileJobStore } from "../src/job/store.js";
import {
  InvalidStateTransitionError,
  JobStateMachine,
} from "../src/job/state-machine.js";
import type { JobRecord, JobStatus } from "../src/job/types.js";

const HAPPY_PATH: readonly { from: JobStatus; to: JobStatus }[] = [
  { from: "UPLOADING", to: "UPLOAD_COMPLETED" },
  { from: "UPLOAD_COMPLETED", to: "PROCESSING" },
  { from: "PROCESSING", to: "AUTO_QA" },
  { from: "AUTO_QA", to: "AUTO_PUBLISH_YOUTUBE" },
  { from: "AUTO_PUBLISH_YOUTUBE", to: "COMPLETED" },
];

describe("JobStateMachine", () => {
  it("aceita todas as transições do caminho feliz", () => {
    for (const step of HAPPY_PATH) {
      expect(JobStateMachine.canTransition(step.from, step.to)).toBe(true);
    }
  });

  it("aceita a falha a partir de qualquer estado ativo", () => {
    const active: JobStatus[] = [
      "UPLOADING",
      "UPLOAD_COMPLETED",
      "PROCESSING",
      "AUTO_QA",
      "AUTO_PUBLISH_YOUTUBE",
    ];
    for (const status of active) {
      expect(JobStateMachine.canTransition(status, "FAILED")).toBe(true);
    }
  });

  it("rejeita saltos ilegais de estado", () => {
    expect(JobStateMachine.canTransition("UPLOADING", "AUTO_QA")).toBe(false);
    expect(
      JobStateMachine.canTransition("PROCESSING", "UPLOAD_COMPLETED"),
    ).toBe(false);
    expect(JobStateMachine.canTransition("COMPLETED", "PROCESSING")).toBe(
      false,
    );
    expect(JobStateMachine.canTransition("COMPLETED", "FAILED")).toBe(false);
  });

  it("lança InvalidStateTransitionError com código e estados", () => {
    let thrown: unknown;
    try {
      JobStateMachine.validateTransition("COMPLETED", "PROCESSING");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(InvalidStateTransitionError);
    const error = thrown as InvalidStateTransitionError;
    expect(error.code).toBe("INVALID_STATE_TRANSITION");
    expect(error.currentStatus).toBe("COMPLETED");
    expect(error.targetStatus).toBe("PROCESSING");
  });

  it("calcula durationMs positivo e nunca negativo", () => {
    const base = Date.now();
    const last = new Date(base - 5000).toISOString();
    const now = new Date(base).toISOString();
    expect(JobStateMachine.calculateDuration(last, now)).toBe(5000);
    expect(JobStateMachine.calculateDuration(now, last)).toBe(0);
    expect(JobStateMachine.calculateDuration("invalid", now)).toBe(0);
    expect(JobStateMachine.calculateDuration(last, "invalid")).toBe(0);
  });
});

describe("FileJobStore com FSM", () => {
  function makeStore(): FileJobStore {
    const dir = mkdtempSync(path.join(os.tmpdir(), "statemachine-store-"));
    return new FileJobStore(dir);
  }

  function seed(
    store: FileJobStore,
    jobId: string,
    uploadId: string,
  ): Promise<JobRecord> {
    return store.create({
      jobId,
      uploadId,
      status: "UPLOADING",
      filePath: `/tmp/${uploadId}`,
      metadata: {
        filename: "a.mp4",
        filetype: "video/mp4",
        totalSize: 10,
        uploadedBytes: 0,
      },
    });
  }

  it("registra histórico com durationMs e metadata", async () => {
    const store = makeStore();
    const created = await seed(store, "job-fsm-1", "upload-fsm-1");
    expect(created.transitions[0]?.durationMs).toBeUndefined();

    const completed = await store.transition(
      "upload-fsm-1",
      "UPLOAD_COMPLETED",
      undefined,
      undefined,
      { codec: "h264" },
    );
    expect(completed.transitions).toHaveLength(2);
    const step = completed.transitions[1];
    expect(step?.from).toBe("UPLOADING");
    expect(step?.to).toBe("UPLOAD_COMPLETED");
    expect(step?.durationMs).toBeGreaterThanOrEqual(0);
    expect(step?.metadata).toEqual({ codec: "h264" });

    const processing = await store.transition("upload-fsm-1", "PROCESSING");
    expect(processing.transitions).toHaveLength(3);
    expect(processing.transitions[2]?.from).toBe("UPLOAD_COMPLETED");
    expect(processing.transitions[2]?.to).toBe("PROCESSING");
    expect(processing.transitions[2]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("rejeita transição ilegal pelo store", async () => {
    const store = makeStore();
    await seed(store, "job-fsm-2", "upload-fsm-2");
    await expect(
      store.transition("upload-fsm-2", "AUTO_QA"),
    ).rejects.toBeInstanceOf(InvalidStateTransitionError);
    const job = await store.get("upload-fsm-2");
    expect(job?.status).toBe("UPLOADING");
    expect(job?.transitions).toHaveLength(1);
  });

  it("update altera campos sem registrar nova transição", async () => {
    const store = makeStore();
    await seed(store, "job-fsm-3", "upload-fsm-3");
    const updated = await store.update("upload-fsm-3", {
      isPurged: true,
      purgedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(updated.status).toBe("UPLOADING");
    expect(updated.transitions).toHaveLength(1);
    expect(updated.isPurged).toBe(true);
    expect(updated.purgedAt).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("POST /uploads/:id/transition", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await startServer();
  });

  afterAll(async () => {
    await stopServer(ctx);
  });

  function transition(
    uploadId: string,
    body: Record<string, unknown>,
    token: string = TEST_TOKEN,
  ): Promise<RawResponse> {
    return rawRequest(
      ctx.baseUrl,
      "POST",
      `${UPLOAD_PATH}/${uploadId}/transition`,
      {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      Buffer.from(JSON.stringify(body), "utf8"),
    );
  }

  async function createUploadId(): Promise<string> {
    const created = await tusCreate(ctx, {
      length: 100,
      metadata: { filename: "pending.mp4", filetype: "video/mp4" },
      token: TEST_TOKEN,
    });
    expect(created.status).toBe(201);
    return (created.headers.location as string).split("/").pop() as string;
  }

  it("bloqueia sem token com 401", async () => {
    const response = await rawRequest(
      ctx.baseUrl,
      "POST",
      `${UPLOAD_PATH}/x/transition`,
    );
    expect(response.status).toBe(401);
  });

  it("bloqueia token inválido com 401", async () => {
    const response = await transition("x", { to: "PROCESSING" }, "invalid");
    expect(response.status).toBe(401);
  });

  it("retorna 404 para upload inexistente", async () => {
    const response = await transition("does-not-exist", { to: "PROCESSING" });
    expect(response.status).toBe(404);
  });

  it("retorna 400 para payload inválido", async () => {
    const uploadId = await createUploadId();
    const missingTo = await transition(uploadId, { metadata: {} });
    expect(missingTo.status).toBe(400);
    const invalidTo = await transition(uploadId, { to: "BOGUS" });
    expect(invalidTo.status).toBe(400);
  });

  it("percorre o caminho feliz e registra histórico com durationMs", async () => {
    const uploadId = await createUploadId();
    const steps: JobStatus[] = [
      "UPLOAD_COMPLETED",
      "PROCESSING",
      "AUTO_QA",
      "AUTO_PUBLISH_YOUTUBE",
      "COMPLETED",
    ];
    let last: JobRecord | null = null;
    for (const to of steps) {
      const response = await transition(uploadId, { to, reason: `step ${to}` });
      expect(response.status).toBe(200);
      last = JSON.parse(response.body.toString("utf8")) as JobRecord;
      expect(last.status).toBe(to);
    }
    expect(last?.status).toBe("COMPLETED");
    expect(last?.transitions).toHaveLength(6);
    expect(last?.transitions[0]?.durationMs).toBeUndefined();
    for (const step of last?.transitions.slice(1) ?? []) {
      expect(step.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("rejeita salto ilegal com 422 e código INVALID_STATE_TRANSITION", async () => {
    const uploadId = await createUploadId();
    const response = await transition(uploadId, { to: "AUTO_QA" });
    expect(response.status).toBe(422);
    const body = JSON.parse(response.body.toString("utf8")) as {
      code: string;
      from: string;
      to: string;
    };
    expect(body.code).toBe("INVALID_STATE_TRANSITION");
    expect(body.from).toBe("UPLOADING");
    expect(body.to).toBe("AUTO_QA");
  });

  it("bloqueia transição a partir do estado terminal COMPLETED", async () => {
    const uploadId = await createUploadId();
    const steps: JobStatus[] = [
      "UPLOAD_COMPLETED",
      "PROCESSING",
      "AUTO_QA",
      "AUTO_PUBLISH_YOUTUBE",
      "COMPLETED",
    ];
    for (const to of steps) {
      const response = await transition(uploadId, { to });
      expect(response.status).toBe(200);
    }
    const response = await transition(uploadId, { to: "PROCESSING" });
    expect(response.status).toBe(422);
    const body = JSON.parse(response.body.toString("utf8")) as {
      code: string;
      from: string;
    };
    expect(body.code).toBe("INVALID_STATE_TRANSITION");
    expect(body.from).toBe("COMPLETED");
  });
});