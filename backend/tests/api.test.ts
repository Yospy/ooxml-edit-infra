import assert from "node:assert/strict";
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  mkdtempSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildApp } from "../src/app.js";
import { HeuristicPlanner } from "../src/planner.js";
import type { AgentEvent, DeckStatus, JobStatus } from "../src/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const samplePath = resolve(__dirname, "..", "..", "sample.pptx");

function tempDataDir(): string {
  return mkdtempSync(join(tmpdir(), "yc-real-backend-"));
}

async function createReadyDeck(dataDir = tempDataDir()) {
  const proprietaryDataDir = `${dataDir}-root-data`;
  const app = buildApp({
    dataDir,
    config: { proprietaryDataDir },
    planner: new HeuristicPlanner(),
  });
  const upload = await app.inject({
    method: "POST",
    url: "/api/decks/upload",
    ...multipartPayload("sample.pptx", readFileSync(samplePath)),
  });
  assert.equal(upload.statusCode, 200, upload.body);
  const uploadBody = upload.json() as { deckId: string; jobId: string };

  const job = await app.inject({
    method: "GET",
    url: `/api/jobs/${uploadBody.jobId}`,
  });
  assert.equal(job.statusCode, 200, job.body);
  assert.equal((job.json() as JobStatus).status, "succeeded");

  const status = await app.inject({
    method: "GET",
    url: `/api/decks/${uploadBody.deckId}/status`,
  });
  assert.equal(status.statusCode, 200, status.body);

  return {
    app,
    dataDir,
    proprietaryDataDir,
    deckId: uploadBody.deckId,
    deck: status.json() as DeckStatus,
  };
}

test("upload stores a real PPTX, parses slides, and serves backend render artifacts", async (t) => {
  const { app, dataDir, deck } = await createReadyDeck();
  t.after(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(`${dataDir}-root-data`, { recursive: true, force: true });
  });

  assert.equal(deck.activeVersionId, "v1");
  assert.equal(deck.originalVersionId, "original");
  assert.equal(deck.slides.length, 2);
  assert.equal(deck.validationSummary.canExport, false);
  assert.ok(deck.slides[0]?.renderUrl);
  assert.ok(deck.slides[0]?.thumbnailUrl);

  const render = await app.inject({
    method: "GET",
    url: deck.slides[0]!.renderUrl!,
  });
  assert.equal(render.statusCode, 200);
  assert.match(render.headers["content-type"] as string, /image\/svg\+xml/);
  assert.match(render.body, /Backend SVG render/);
});

test("sample upload fallback creates a deck for the UI skip action", async (t) => {
  const dataDir = tempDataDir();
  const app = buildApp({
    dataDir,
    config: { proprietaryDataDir: `${dataDir}-root-data` },
    planner: new HeuristicPlanner(),
  });
  t.after(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(`${dataDir}-root-data`, { recursive: true, force: true });
  });

  const upload = await app.inject({
    method: "POST",
    url: "/api/decks/upload",
    payload: {},
  });
  assert.equal(upload.statusCode, 200, upload.body);
  const body = upload.json() as { deckId: string };

  const status = await app.inject({
    method: "GET",
    url: `/api/decks/${body.deckId}/status`,
  });
  assert.equal(status.statusCode, 200);
  assert.equal((status.json() as DeckStatus).slides.length, 2);
});

test("invalid pptx upload returns a structured error", async (t) => {
  const dataDir = tempDataDir();
  const app = buildApp({
    dataDir,
    config: { proprietaryDataDir: `${dataDir}-root-data` },
    planner: new HeuristicPlanner(),
  });
  t.after(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(`${dataDir}-root-data`, { recursive: true, force: true });
  });

  const upload = await app.inject({
    method: "POST",
    url: "/api/decks/upload",
    ...multipartPayload("bad.pptx", Buffer.from("not a pptx")),
  });
  assert.equal(upload.statusCode, 400);
  assert.equal(upload.json().error.code, "INVALID_PPTX");
});

test("deck metadata persists across app instances", async (t) => {
  const dataDir = tempDataDir();
  const created = await createReadyDeck(dataDir);
  const deckId = created.deckId;
  await created.app.close();

  const app = buildApp({
    dataDir,
    config: { proprietaryDataDir: `${dataDir}-root-data` },
    planner: new HeuristicPlanner(),
  });
  t.after(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(`${dataDir}-root-data`, { recursive: true, force: true });
  });

  const status = await app.inject({
    method: "GET",
    url: `/api/decks/${deckId}/status`,
  });
  assert.equal(status.statusCode, 200, status.body);
  assert.equal((status.json() as DeckStatus).activeVersionId, "v1");
});

test("accept is blocked before backend validation allows it", async (t) => {
  const { app, dataDir, deckId } = await createReadyDeck();
  t.after(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(`${dataDir}-root-data`, { recursive: true, force: true });
  });

  const accept = await app.inject({
    method: "POST",
    url: `/api/decks/${deckId}/versions/v1/accept`,
    payload: {},
  });

  assert.equal(accept.statusCode, 409);
  assert.equal(accept.json().error.code, "ACCEPT_BLOCKED");
});

test("edit request creates plan and approval decision without mutating deck", async (t) => {
  const { app, dataDir, deckId, deck } = await createReadyDeck();
  t.after(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(`${dataDir}-root-data`, { recursive: true, force: true });
  });

  const response = await app.inject({
    method: "POST",
    url: `/api/decks/${deckId}/edit-requests`,
    payload: {
      versionId: deck.activeVersionId,
      message: "Make the title shorter",
      selectedSlideId: "slide_1",
      selectedElementIds: [],
    },
  });

  assert.equal(response.statusCode, 200, response.body);
  const body = response.json() as {
    editPlan: { status: string };
    decisionRequest: { inputMode: string };
  };
  assert.equal(body.editPlan.status, "awaiting_approval");
  assert.equal(body.decisionRequest.inputMode, "yes_no");

  const after = await app.inject({
    method: "GET",
    url: `/api/decks/${deckId}/status`,
  });
  assert.equal((after.json() as DeckStatus).activeVersionId, "v1");
});

test("rejecting plan decision preserves active version", async (t) => {
  const { app, dataDir, proprietaryDataDir, deckId, deck } = await createReadyDeck();
  t.after(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(`${dataDir}-root-data`, { recursive: true, force: true });
  });

  const planResponse = await app.inject({
    method: "POST",
    url: `/api/decks/${deckId}/edit-requests`,
    payload: {
      versionId: deck.activeVersionId,
      message: "Make the title shorter",
      selectedSlideId: "slide_1",
    },
  });
  const planBody = planResponse.json() as {
    editPlan: { planId: string };
    decisionRequest: { decisionId: string };
  };

  const reject = await app.inject({
    method: "POST",
    url: `/api/decks/${deckId}/decisions/${planBody.decisionRequest.decisionId}/respond`,
    payload: {
      versionId: "v1",
      selectedOptionId: "reject",
    },
  });
  assert.equal(reject.statusCode, 200, reject.body);
  assert.equal((reject.json() as { deckStatus: DeckStatus }).deckStatus.activeVersionId, "v1");
  assert.equal(readFinalChangeEvents(proprietaryDataDir).length, 0);
});

test("approving edit creates v2 review result and exportable PPTX", async (t) => {
  const { app, dataDir, proprietaryDataDir, deckId, deck } = await createReadyDeck();
  t.after(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(`${dataDir}-root-data`, { recursive: true, force: true });
  });

  const planResponse = await app.inject({
    method: "POST",
    url: `/api/decks/${deckId}/edit-requests`,
    payload: {
      versionId: deck.activeVersionId,
      message: "Make the title shorter",
      selectedSlideId: "slide_1",
      selectedElementIds: [],
    },
  });
  const planBody = planResponse.json() as {
    editPlan: { planId: string };
    decisionRequest: { decisionId: string };
  };

  const decisionResponse = await app.inject({
    method: "POST",
    url: `/api/decks/${deckId}/decisions/${planBody.decisionRequest.decisionId}/respond`,
    payload: {
      versionId: "v1",
      selectedOptionId: "apply",
    },
  });
  assert.equal(decisionResponse.statusCode, 200, decisionResponse.body);
  const decisionBody = decisionResponse.json() as { jobId: string };

  const job = await app.inject({
    method: "GET",
    url: `/api/jobs/${decisionBody.jobId}`,
  });
  assert.equal(job.statusCode, 200, job.body);
  const jobBody = job.json() as JobStatus & {
    result: {
      deckStatus: DeckStatus;
      reviewResult: {
        outputVersionId: string;
        slidePreviews: Array<{ after: { renderUrl?: string } }>;
      };
      events: AgentEvent[];
      decisionRequest: {
        decisionId: string;
        purpose: string;
        inputMode: string;
        options: Array<{ id: string; label: string }>;
      };
    };
  };
  assert.equal(jobBody.status, "succeeded");
  assert.equal(jobBody.result.reviewResult.outputVersionId, "v2");
  assert.equal(jobBody.result.deckStatus.activeVersionId, "v2");
  assert.equal(jobBody.result.deckStatus.validationSummary.canExport, true);
  assert.ok(jobBody.result.reviewResult.slidePreviews[0]?.after.renderUrl);
  assert.equal(jobBody.result.decisionRequest.purpose, "final_edit_review");
  assert.equal(jobBody.result.decisionRequest.inputMode, "single_choice");
  assert.deepEqual(
    jobBody.result.decisionRequest.options.map((option) => option.id),
    ["accept", "refine", "reject"],
  );
  assert.equal(readFinalChangeEvents(proprietaryDataDir).length, 0);

  const accept = await app.inject({
    method: "POST",
    url: `/api/decks/${deckId}/decisions/${jobBody.result.decisionRequest.decisionId}/respond`,
    payload: {
      versionId: "v2",
      selectedOptionId: "accept",
    },
  });
  assert.equal(accept.statusCode, 200, accept.body);
  const acceptedDeck = (accept.json() as { deckStatus: DeckStatus }).deckStatus;
  assert.equal(acceptedDeck.versions.find((version) => version.id === "v2")?.status, "accepted");
  const events = readFinalChangeEvents(proprietaryDataDir);
  assert.equal(events.length, 1);
  assert.equal(events[0].event_type, "final_change_event");
  assert.equal(events[0].decision, "accepted");
  assert.equal(events[0].deck_id, deckId);
  assert.equal(events[0].plan_id, planBody.editPlan.planId);
  assert.equal(events[0].decision_id, jobBody.result.decisionRequest.decisionId);
  assert.equal(events[0].user_prompt, "Make the title shorter");
  assert.equal(events[0].input_version_id, "v1");
  assert.equal(events[0].output_version_id, "v2");
  assert.deepEqual(events[0].changed_slide_ids, ["slide_1"]);
  assert.ok(Array.isArray(events[0].change_patch));
  assert.ok(events[0].before_state.slides.length > 0);
  assert.ok(events[0].after_state.slides.length > 0);
  assert.ok(events[0].render_artifacts.before[0]?.path);
  assert.ok(events[0].render_artifacts.after[0]?.path);
  assert.equal(events[0].provenance.model_version, "gpt-5.5");
  assert.equal(events[0].provenance.prompt_version, "slide_edit_v1");

  const exported = await app.inject({
    method: "POST",
    url: `/api/decks/${deckId}/versions/v2/export`,
    payload: {},
  });
  assert.equal(exported.statusCode, 200, exported.body);
  const exportBody = exported.json() as { exportArtifact: { status: string; downloadUrl: string } };
  assert.equal(exportBody.exportArtifact.status, "prepared");

  const download = await app.inject({
    method: "GET",
    url: exportBody.exportArtifact.downloadUrl,
  });
  assert.equal(download.statusCode, 200);
  assert.match(download.headers["content-type"] as string, /presentationml\.presentation/);
});

test("stale decision version is rejected", async (t) => {
  const { app, dataDir, deckId, deck } = await createReadyDeck();
  t.after(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(`${dataDir}-root-data`, { recursive: true, force: true });
  });

  const planResponse = await app.inject({
    method: "POST",
    url: `/api/decks/${deckId}/edit-requests`,
    payload: {
      versionId: deck.activeVersionId,
      message: "Make the title shorter",
      selectedSlideId: "slide_1",
    },
  });
  const planBody = planResponse.json() as {
    decisionRequest: { decisionId: string };
  };

  const stale = await app.inject({
    method: "POST",
    url: `/api/decks/${deckId}/decisions/${planBody.decisionRequest.decisionId}/respond`,
    payload: {
      versionId: "v2",
      selectedOptionId: "apply",
    },
  });
  assert.equal(stale.statusCode, 409);
});

test("refining final edit review keeps edited version active without capture", async (t) => {
  const { app, dataDir, proprietaryDataDir, deckId, deck } = await createReadyDeck();
  t.after(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(`${dataDir}-root-data`, { recursive: true, force: true });
  });

  const planResponse = await app.inject({
    method: "POST",
    url: `/api/decks/${deckId}/edit-requests`,
    payload: {
      versionId: deck.activeVersionId,
      message: "Make the title shorter",
      selectedSlideId: "slide_1",
    },
  });
  const planBody = planResponse.json() as {
    decisionRequest: { decisionId: string };
  };
  const apply = await app.inject({
    method: "POST",
    url: `/api/decks/${deckId}/decisions/${planBody.decisionRequest.decisionId}/respond`,
    payload: {
      versionId: "v1",
      selectedOptionId: "apply",
    },
  });
  const applyJob = await app.inject({
    method: "GET",
    url: `/api/jobs/${(apply.json() as { jobId: string }).jobId}`,
  });
  const applyJobBody = applyJob.json() as JobStatus & {
    result: { decisionRequest: { decisionId: string } };
  };

  const refine = await app.inject({
    method: "POST",
    url: `/api/decks/${deckId}/decisions/${applyJobBody.result.decisionRequest.decisionId}/respond`,
    payload: {
      versionId: "v2",
      selectedOptionId: "refine",
    },
  });
  assert.equal(refine.statusCode, 200, refine.body);
  const refinedDeck = (refine.json() as { deckStatus: DeckStatus }).deckStatus;
  assert.equal(refinedDeck.activeVersionId, "v2");
  assert.equal(refinedDeck.versions.find((version) => version.id === "v2")?.status, "edited");
  assert.equal(readFinalChangeEvents(proprietaryDataDir).length, 0);
});

test("rejecting edited version restores the previous active version", async (t) => {
  const { app, dataDir, proprietaryDataDir, deckId, deck } = await createReadyDeck();
  t.after(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(`${dataDir}-root-data`, { recursive: true, force: true });
  });

  const planResponse = await app.inject({
    method: "POST",
    url: `/api/decks/${deckId}/edit-requests`,
    payload: {
      versionId: deck.activeVersionId,
      message: "Make the title shorter",
      selectedSlideId: "slide_1",
    },
  });
  const planBody = planResponse.json() as {
    decisionRequest: { decisionId: string };
  };
  const apply = await app.inject({
    method: "POST",
    url: `/api/decks/${deckId}/decisions/${planBody.decisionRequest.decisionId}/respond`,
    payload: {
      versionId: "v1",
      selectedOptionId: "apply",
    },
  });
  const applyJob = await app.inject({
    method: "GET",
    url: `/api/jobs/${(apply.json() as { jobId: string }).jobId}`,
  });
  const applyJobBody = applyJob.json() as JobStatus & {
    result: { decisionRequest: { decisionId: string } };
  };
  assert.equal(applyJobBody.status, "succeeded");

  const rejected = await app.inject({
    method: "POST",
    url: `/api/decks/${deckId}/decisions/${applyJobBody.result.decisionRequest.decisionId}/respond`,
    payload: {
      versionId: "v2",
      selectedOptionId: "reject",
    },
  });
  assert.equal(rejected.statusCode, 200, rejected.body);
  assert.equal((rejected.json() as { deckStatus: DeckStatus }).deckStatus.activeVersionId, "v1");
  const events = readFinalChangeEvents(proprietaryDataDir);
  assert.equal(events.length, 1);
  assert.equal(events[0].decision, "rejected");
  assert.equal(events[0].input_version_id, "v1");
  assert.equal(events[0].output_version_id, "v2");
});

function readFinalChangeEvents(proprietaryDataDir: string): Array<Record<string, any>> {
  return finalChangeEventFiles(proprietaryDataDir).map((file) =>
    JSON.parse(readFileSync(file, "utf8")) as Record<string, any>,
  );
}

function finalChangeEventFiles(proprietaryDataDir: string): string[] {
  const root = join(proprietaryDataDir, "final-change-events");
  if (!existsSync(root)) return [];
  return walkFiles(root).filter((file) => file.endsWith(".json")).sort();
}

function walkFiles(path: string): string[] {
  return readdirSync(path).flatMap((entry) => {
    const child = join(path, entry);
    return statSync(child).isDirectory() ? walkFiles(child) : [child];
  });
}

function multipartPayload(filename: string, file: Buffer) {
  const boundary = `----codex-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      "Content-Type: application/vnd.openxmlformats-officedocument.presentationml.presentation\r\n\r\n",
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const payload = Buffer.concat([head, file, tail]);
  return {
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "content-length": String(payload.length),
    },
    payload,
  };
}
