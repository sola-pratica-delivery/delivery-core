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
import { InvalidStateTransitionError } from "../src/job/state-machine.js";
import type {
  JobRecord,
  JobStatus,
  YouTubeVideoPublication,
  YouTubeShortPublication,
} from "../src/job/types.js";
import type { QueueManager } from "../src/queue/types.js";

const LONG_VIDEO: YouTubeVideoPublication = {
  videoId: "long-video-1",
  videoUrl: "https://youtube.com/watch?v=long-video-1",
  title: "Full Video",
  publishedAt: "2026-09-17T00:00:00.000Z",
  privacyStatus: "public",
};

const SHORTS: YouTubeShortPublication[] = [
  {
    shortId: "short-1",
    videoId: "short-video-1",
    videoUrl: "https://youtube.com/shorts/short-video-1",
    title: "Cut 1",
    publishedAt: "2026-09-17T00:00:00.000Z",
    cutIndex: 0,
  },
];

const PUBLICATION_PAYLOAD = {
  youtube: { longVideo: LONG_VIDEO, shorts: SHORTS },
  cuts: {
    totalCuts: 1,
    totalDurationSeconds: 12,
    averageDurationSeconds: 12,
    items: [
      {
        cutId: "cut-1",
        startTimeSeconds: 0,
        endTimeSeconds: 12,
        durationSeconds: 12,
        aspectRatio: "9:16",
        headline: "Highlight",
        shortId: "short-1",
        youtubeVideoId: "short-video-1",
        youtubeUrl: "https://youtube.com/shorts/short-video-1",
      },
    ],
  },
};

describe("FileJobStore.completeJob", () => {
  function makeStore(): FileJobStore {
    const dir = mkdtempSync(path.join(os.tmpdir(), "final-archive-store-"));
    return new FileJobStore(dir);
  }

  async function seedAt(
    store: FileJobStore,
    uploadId: string,
    target: JobStatus,
    jobId: string = `job-${uploadId}`,
  ): Promise<JobRecord> {
    const created = await store.create({
      jobId,
      uploadId,
      status: "UPLOADING",
      filePath: `/tmp/${uploadId}`,
      metadata: {
        filename: "final.mp4",
        filetype: "video/mp4",
        totalSize: 100,
        uploadedBytes: 0,
      },
    });
    const order: JobStatus[] = [
      "UPLOAD_COMPLETED",
      "PROCESSING",
      "AUTO_QA",
      "AUTO_PUBLISH_YOUTUBE",
    ];
    let job = created;
    for (const to of order) {
      if (target === "UPLOADING") {
        break;
      }
      job = await store.transition(uploadId, to, `step ${to}`);
      if (to === target) {
        break;
      }
    }
    return job;
  }

  it("CA-1/CA-2/CA-3: arquiva publication e conclui a partir de AUTO_PUBLISH_YOUTUBE", async () => {
    const store = makeStore();
    await seedAt(store, "ca-complete", "AUTO_PUBLISH_YOUTUBE");

    const completed = await store.completeJob("ca-complete", PUBLICATION_PAYLOAD);

    expect(completed.status).toBe("COMPLETED");
    expect(completed.completedAt).toEqual(expect.any(String));
    expect(completed.publication?.youtube).toEqual(PUBLICATION_PAYLOAD.youtube);
    expect(completed.publication?.cuts).toEqual(PUBLICATION_PAYLOAD.cuts);
    expect(completed.publication?.archivedAt).toBe(completed.completedAt);
    const last = completed.transitions.at(-1);
    expect(last?.from).toBe("AUTO_PUBLISH_YOUTUBE");
    expect(last?.to).toBe("COMPLETED");
    expect(last?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("respeita archivedAt fornecido explicitamente", async () => {
    const store = makeStore();
    await seedAt(store, "ca-custom", "AUTO_PUBLISH_YOUTUBE");

    const archivedAt = "2026-01-01T00:00:00.000Z";
    const completed = await store.completeJob("ca-custom", {
      ...PUBLICATION_PAYLOAD,
      archivedAt,
    });

    expect(completed.publication?.archivedAt).toBe(archivedAt);
    expect(completed.status).toBe("COMPLETED");
  });

  it("edge 5: preserva arquivamento parcial (apenas vídeo longo)", async () => {
    const store = makeStore();
    await seedAt(store, "ca-partial", "AUTO_PUBLISH_YOUTUBE");

    const completed = await store.completeJob("ca-partial", {
      youtube: { longVideo: LONG_VIDEO },
    });

    expect(completed.publication?.youtube?.longVideo?.videoId).toBe(
      "long-video-1",
    );
    expect(completed.publication?.youtube?.shorts).toBeUndefined();
    expect(completed.publication?.cuts).toBeUndefined();
  });

  it("edge 5: permite conclusão sem bloco de publicação", async () => {
    const store = makeStore();
    await seedAt(store, "ca-nopub", "AUTO_PUBLISH_YOUTUBE");

    const completed = await store.completeJob("ca-nopub");

    expect(completed.status).toBe("COMPLETED");
    expect(completed.completedAt).toEqual(expect.any(String));
    expect(completed.publication).toBeUndefined();
  });

  it("edge 1: rejeita completeJob a partir de PROCESSING com 422-InvalidStateTransition", async () => {
    const store = makeStore();
    await seedAt(store, "edge-1", "PROCESSING");

    await expect(
      store.completeJob("edge-1", PUBLICATION_PAYLOAD),
    ).rejects.toBeInstanceOf(InvalidStateTransitionError);
    const job = await store.get("edge-1");
    expect(job?.status).toBe("PROCESSING");
    expect(job?.publication).toBeUndefined();
  });

  it("edge 2: rejeita completeJob reentrante quando já COMPLETED", async () => {
    const store = makeStore();
    await seedAt(store, "edge-2", "AUTO_PUBLISH_YOUTUBE");
    await store.completeJob("edge-2", PUBLICATION_PAYLOAD);

    await expect(
      store.completeJob("edge-2", PUBLICATION_PAYLOAD),
    ).rejects.toBeInstanceOf(InvalidStateTransitionError);

    const job = await store.get("edge-2");
    expect(job?.transitions).toHaveLength(6);
    expect(job?.publication?.cuts?.totalCuts).toBe(1);
    expect(job?.publication?.youtube).toEqual(PUBLICATION_PAYLOAD.youtube);
  });

  it("lança erro ao concluir job inexistente", async () => {
    const store = makeStore();
    await expect(store.completeJob("nope")).rejects.toThrow("Job not found");
  });

  it("persiste o bloco publication atomicamente em disco", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "final-archive-disk-"));
    const store = new FileJobStore(dir);
    await seedAt(store, "ca-disk", "AUTO_PUBLISH_YOUTUBE", "job-ca-disk");
    await store.completeJob("ca-disk", PUBLICATION_PAYLOAD);

    const reloaded = new FileJobStore(dir);
    const job = await reloaded.get("job-ca-disk");
    expect(job?.status).toBe("COMPLETED");
    expect(job?.completedAt).toEqual(expect.any(String));
    expect(job?.publication?.youtube?.longVideo?.videoId).toBe("long-video-1");
    expect(job?.publication?.youtube?.shorts).toHaveLength(1);
    expect(job?.publication?.cuts?.totalCuts).toBe(1);
    expect(job?.publication?.archivedAt).toEqual(expect.any(String));
  });
});

describe("POST /uploads/:id/transition com arquivamento final", () => {
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

  async function drive(uploadId: string, target: JobStatus): Promise<void> {
    const order: JobStatus[] = [
      "UPLOAD_COMPLETED",
      "PROCESSING",
      "AUTO_QA",
      "AUTO_PUBLISH_YOUTUBE",
    ];
    for (const to of order) {
      if (target === "UPLOADING") {
        break;
      }
      const response = await transition(uploadId, { to, reason: `step ${to}` });
      expect(response.status).toBe(200);
      if (to === target) {
        break;
      }
    }
  }

  function getJob(uploadId: string): Promise<RawResponse> {
    return rawRequest(
      ctx.baseUrl,
      "GET",
      `${UPLOAD_PATH}/${uploadId}/job`,
      { authorization: `Bearer ${TEST_TOKEN}` },
    );
  }

  it("CA-3: transição para COMPLETED via HTTP arquiva publication e durationMs", async () => {
    const uploadId = await createUploadId();
    await drive(uploadId, "AUTO_PUBLISH_YOUTUBE");

    const response = await transition(uploadId, {
      to: "COMPLETED",
      reason: "Publication finished",
      publication: PUBLICATION_PAYLOAD,
    });
    expect(response.status).toBe(200);

    const job = JSON.parse(response.body.toString("utf8")) as JobRecord;
    expect(job.status).toBe("COMPLETED");
    expect(job.completedAt).toEqual(expect.any(String));
    expect(job.publication?.youtube).toEqual(PUBLICATION_PAYLOAD.youtube);
    expect(job.publication?.cuts).toEqual(PUBLICATION_PAYLOAD.cuts);
    expect(job.publication?.archivedAt).toEqual(expect.any(String));
    const last = job.transitions.at(-1);
    expect(last?.from).toBe("AUTO_PUBLISH_YOUTUBE");
    expect(last?.to).toBe("COMPLETED");
    expect(last?.durationMs).toBeGreaterThanOrEqual(0);
    expect(last?.reason).toBe("Publication finished");
  });

  it("CA-6: GET /uploads/:id/job devolve todos os dados arquivados", async () => {
    const uploadId = await createUploadId();
    await drive(uploadId, "AUTO_PUBLISH_YOUTUBE");
    const done = await transition(uploadId, {
      to: "COMPLETED",
      publication: PUBLICATION_PAYLOAD,
    });
    expect(done.status).toBe(200);

    const response = await getJob(uploadId);
    expect(response.status).toBe(200);
    const job = JSON.parse(response.body.toString("utf8")) as JobRecord;
    expect(job.status).toBe("COMPLETED");
    expect(job.publication?.youtube?.longVideo?.videoId).toBe("long-video-1");
    expect(job.publication?.youtube?.shorts?.[0]?.cutIndex).toBe(0);
    expect(job.publication?.cuts?.items?.[0]?.cutId).toBe("cut-1");
    expect(job.publication?.cuts?.items?.[0]?.aspectRatio).toBe("9:16");
  });

  it("CA-4: finalização silenciosa sem DLQ nem eventos de erro", async () => {
    const manager = (ctx.app as unknown as { queueManager: QueueManager })
      .queueManager;
    const uploadId = await createUploadId();
    await drive(uploadId, "AUTO_PUBLISH_YOUTUBE");

    const response = await transition(uploadId, {
      to: "COMPLETED",
      publication: PUBLICATION_PAYLOAD,
    });
    expect(response.status).toBe(200);

    expect(await manager.getDlqJobs()).toHaveLength(0);
  });

  it("edge 3: rejeita publication malformado com 400 INVALID_PAYLOAD", async () => {
    const uploadId = await createUploadId();
    await drive(uploadId, "AUTO_PUBLISH_YOUTUBE");

    const negativeTotalCuts = await transition(uploadId, {
      to: "COMPLETED",
      publication: { cuts: { totalCuts: -1 } },
    });
    expect(negativeTotalCuts.status).toBe(400);
    expect(
      (JSON.parse(negativeTotalCuts.body.toString("utf8")) as { code: string })
        .code,
    ).toBe("INVALID_PAYLOAD");

    const missingVideoId = await transition(uploadId, {
      to: "COMPLETED",
      publication: {
        youtube: {
          longVideo: { videoId: "", videoUrl: "https://youtube.com/w?v=1" },
        },
      },
    });
    expect(missingVideoId.status).toBe(400);
    expect(
      (JSON.parse(missingVideoId.body.toString("utf8")) as { code: string })
        .code,
    ).toBe("INVALID_PAYLOAD");

    const job = await getJob(uploadId);
    const body = JSON.parse(job.body.toString("utf8")) as JobRecord;
    expect(body.status).toBe("AUTO_PUBLISH_YOUTUBE");
    expect(body.publication).toBeUndefined();
  });

  it("edge 1: rejeita COMPLETED fora de AUTO_PUBLISH_YOUTUBE com 422", async () => {
    const uploadId = await createUploadId();
    await drive(uploadId, "PROCESSING");

    const response = await transition(uploadId, { to: "COMPLETED" });
    expect(response.status).toBe(422);
    const body = JSON.parse(response.body.toString("utf8")) as {
      code: string;
      from: string;
      to: string;
    };
    expect(body.code).toBe("INVALID_STATE_TRANSITION");
    expect(body.from).toBe("PROCESSING");
    expect(body.to).toBe("COMPLETED");
  });

  it("edge 2 / CA-5: bloqueia transições posteriores a partir de COMPLETED", async () => {
    const uploadId = await createUploadId();
    await drive(uploadId, "AUTO_PUBLISH_YOUTUBE");
    const completed = await transition(uploadId, {
      to: "COMPLETED",
      publication: PUBLICATION_PAYLOAD,
    });
    expect(completed.status).toBe(200);

    const again = await transition(uploadId, {
      to: "COMPLETED",
      publication: PUBLICATION_PAYLOAD,
    });
    expect(again.status).toBe(422);
    expect(
      (JSON.parse(again.body.toString("utf8")) as { code: string }).code,
    ).toBe("INVALID_STATE_TRANSITION");

    const job = await getJob(uploadId);
    const body = JSON.parse(job.body.toString("utf8")) as JobRecord;
    expect(body.status).toBe("COMPLETED");
    expect(body.publication?.cuts?.totalCuts).toBe(1);
    expect(body.publication?.youtube).toEqual(PUBLICATION_PAYLOAD.youtube);
    expect(body.transitions).toHaveLength(6);
  });
});