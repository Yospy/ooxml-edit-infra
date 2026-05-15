import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  mkdtempSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildApp } from "../src/app.js";
import {
  applyRegistryOperations,
  buildOperationMenu,
  validatePlanAgainstRegistry,
  validateOperationSelection,
} from "../src/operation-registry.js";
import { HeuristicPlanner, type Planner } from "../src/planner.js";
import type { CanonicalGraph } from "../src/repository.js";
import type { AgentEvent, DeckStatus, JobStatus } from "../src/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const samplePath = resolve(__dirname, "..", "..", "sample.pptx");

function tempDataDir(): string {
  return mkdtempSync(join(tmpdir(), "yc-real-backend-"));
}

async function createReadyDeck(dataDir = tempDataDir(), planner: Planner = new HeuristicPlanner()) {
  const proprietaryDataDir = `${dataDir}-root-data`;
  const app = buildApp({
    dataDir,
    config: { proprietaryDataDir },
    planner,
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
  assert.equal(deck.slides[0]?.widthEmu, 9_144_000);
  assert.equal(deck.slides[0]?.heightEmu, 5_143_500);
  assert.ok(deck.slides[0]?.elements.length);
  assert.deepEqual(
    deck.slides[0]?.elements.map((element) => element.targetRef).sort(),
    ["slide_1.shape_body", "slide_1.shape_title"],
  );
  const titleElement = deck.slides[0]?.elements.find((element) => element.role === "title");
  assert.deepEqual(
    deck.slides[0]?.elements.map((element) => element.role).sort(),
    ["body", "title"],
  );
  assert.equal(titleElement?.targetRef, "slide_1.shape_title");
  assert.equal(titleElement?.elementType, "text_box");
  assert.equal(titleElement?.bounds.x, 685800);
  assert.match(titleElement?.label ?? "", /^Title:/);
  const bodyElement = deck.slides[0]?.elements.find((element) => element.role === "body");
  assert.equal(bodyElement?.bounds.y, 2743200);

  const render = await app.inject({
    method: "GET",
    url: deck.slides[0]!.renderUrl!,
  });
  assert.equal(render.statusCode, 200);
  assert.match(render.headers["content-type"] as string, /image\/svg\+xml/);
  assert.doesNotMatch(render.body, /Backend SVG render/);
  assert.match(render.body, /<text x="72\.0" y="154\.0"[^>]*>Sample Deck<\/text>/);
  assert.match(
    render.body,
    /<text x="72\.0" y="306\.0"[^>]*>Hello from the YC Startup Prospect test fixture<\/text>/,
  );
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

  const current = await app.inject({
    method: "GET",
    url: "/api/workspace/current",
  });
  assert.equal(current.statusCode, 200, current.body);
  assert.equal(
    (current.json() as { deckStatus: DeckStatus | null }).deckStatus?.deckId,
    deckId,
  );
});

test("deck threads persist metadata and explicit edit messages", async (t) => {
  const { app, dataDir, deckId, deck } = await createReadyDeck();
  t.after(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(`${dataDir}-root-data`, { recursive: true, force: true });
  });

  const created = await app.inject({
    method: "POST",
    url: `/api/decks/${deckId}/threads`,
    payload: {},
  });
  assert.equal(created.statusCode, 200, created.body);
  const createdThread = created.json() as {
    thread: {
      threadId: string;
      deckId: string;
      title: string;
      messageCount: number;
      updatedAt: string;
    };
  };
  assert.equal(createdThread.thread.deckId, deckId);
  assert.equal(createdThread.thread.messageCount, 0);

  await delay(5);

  const response = await app.inject({
    method: "POST",
    url: `/api/decks/${deckId}/edit-requests`,
    payload: {
      versionId: deck.activeVersionId,
      threadId: createdThread.thread.threadId,
      message: "Make the title shorter",
      selectedSlideId: "slide_1",
      selectedElementIds: [],
    },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(
    (response.json() as { threadId: string }).threadId,
    createdThread.thread.threadId,
  );

  const listed = await app.inject({
    method: "GET",
    url: `/api/decks/${deckId}/threads`,
  });
  assert.equal(listed.statusCode, 200, listed.body);
  const threads = (listed.json() as {
    threads: Array<{ threadId: string; messageCount: number; updatedAt: string }>;
  }).threads;
  const updated = threads.find(
    (thread) => thread.threadId === createdThread.thread.threadId,
  );
  assert.ok(updated);
  assert.equal(updated.messageCount, 2);
  assert.notEqual(updated.updatedAt, createdThread.thread.updatedAt);
});

test("edit requests reject thread ids from another deck", async (t) => {
  const { app, dataDir, deckId, deck } = await createReadyDeck();
  t.after(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(`${dataDir}-root-data`, { recursive: true, force: true });
  });

  const threadResponse = await app.inject({
    method: "POST",
    url: `/api/decks/${deckId}/threads`,
    payload: {},
  });
  assert.equal(threadResponse.statusCode, 200, threadResponse.body);
  const foreignThreadId = (threadResponse.json() as {
    thread: { threadId: string };
  }).thread.threadId;

  const secondUpload = await app.inject({
    method: "POST",
    url: "/api/decks/upload",
    ...multipartPayload("sample.pptx", readFileSync(samplePath)),
  });
  assert.equal(secondUpload.statusCode, 200, secondUpload.body);
  const secondDeckId = (secondUpload.json() as { deckId: string }).deckId;

  const rejected = await app.inject({
    method: "POST",
    url: `/api/decks/${secondDeckId}/edit-requests`,
    payload: {
      versionId: deck.activeVersionId,
      threadId: foreignThreadId,
      message: "Make the title shorter",
      selectedSlideId: "slide_1",
      selectedElementIds: [],
    },
  });
  assert.equal(rejected.statusCode, 404, rejected.body);
  assert.equal(rejected.json().error.code, "THREAD_NOT_FOUND");
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
    events: AgentEvent[];
    editPlan: { status: string; affectedSlides: string[] };
    decisionRequest: { inputMode: string };
    proposalPreview: {
      slideId: string;
      renderUrl?: string;
      targetRefs: string[];
    };
  };
  assert.equal(body.editPlan.status, "awaiting_approval");
  assert.deepEqual(body.editPlan.affectedSlides, ["slide_1"]);
  assert.equal(body.decisionRequest.inputMode, "yes_no");
  assert.equal(body.proposalPreview.slideId, "slide_1");
  assert.ok(body.proposalPreview.renderUrl);
  assert.ok(body.proposalPreview.targetRefs.every((targetRef) => targetRef.startsWith("slide_1.")));
  assertReasoningEvents(body.events, [
    "Checking the selected slide.",
    "Selecting from the allowed operation menu.",
    "Preparing a preview.",
  ]);

  const after = await app.inject({
    method: "GET",
    url: `/api/decks/${deckId}/status`,
  });
  assert.equal((after.json() as DeckStatus).activeVersionId, "v1");
  assert.equal((after.json() as DeckStatus).versions.length, deck.versions.length);
});

test("edit request targets slide 2 when slide 2 is selected", async (t) => {
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
      selectedSlideId: "slide_2",
      selectedSlideContext: {
        slideId: "slide_2",
        number: 2,
        title: "Slide Two",
        subtitle: "Edit me to verify the comparison",
        activeVersionId: deck.activeVersionId,
      },
      selectedElementIds: [],
    },
  });

  assert.equal(response.statusCode, 200, response.body);
  const body = response.json() as {
    editPlan: { affectedSlides: string[] };
    proposalPreview: {
      slideId: string;
      renderUrl?: string;
      operations: Array<{ targetRef: string }>;
    };
  };
  assert.deepEqual(body.editPlan.affectedSlides, ["slide_2"]);
  assert.equal(body.proposalPreview.slideId, "slide_2");
  assert.ok(body.proposalPreview.renderUrl);
  assert.ok(
    body.proposalPreview.operations.every((operation) =>
      operation.targetRef.startsWith("slide_2."),
    ),
  );
});

test("target resolver maps heading request to title element", async (t) => {
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
      message: "Change heading from Sample Deck to Hello World",
      selectedSlideId: "slide_1",
      selectedElementIds: [],
    },
  });

  assert.equal(response.statusCode, 200, response.body);
  const body = response.json() as {
    editPlan: { operations: Array<{ targetRef: string; after: string }> };
    proposalPreview: { targetRefs: string[] };
  };
  assert.deepEqual(body.proposalPreview.targetRefs, ["slide_1.shape_title"]);
  assert.equal(body.editPlan.operations[0]?.targetRef, "slide_1.shape_title");
  assert.equal(body.editPlan.operations[0]?.after, "Hello World");
});

test("target resolver maps description request to body element", async (t) => {
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
      message: "Change description to YC Deck",
      selectedSlideId: "slide_1",
      selectedElementIds: [],
    },
  });

  assert.equal(response.statusCode, 200, response.body);
  const body = response.json() as {
    editPlan: { operations: Array<{ targetRef: string; after: string }> };
    proposalPreview: { targetRefs: string[] };
  };
  assert.deepEqual(body.proposalPreview.targetRefs, ["slide_1.shape_body"]);
  assert.equal(body.editPlan.operations[0]?.targetRef, "slide_1.shape_body");
  assert.equal(body.editPlan.operations[0]?.after, "YC Deck");
});

test("target resolver lets exact existing text beat an incorrect semantic label", async (t) => {
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
      message: 'Change description from Sample Deck to Hello World',
      selectedSlideId: "slide_1",
      selectedElementIds: [],
    },
  });

  assert.equal(response.statusCode, 200, response.body);
  const body = response.json() as {
    editPlan: { operations: Array<{ targetRef: string; after: string }> };
  };
  assert.equal(body.editPlan.operations[0]?.targetRef, "slide_1.shape_title");
  assert.equal(body.editPlan.operations[0]?.after, "Hello World");
});

test("target resolver honors explicit selected element when prompt is underspecified", async (t) => {
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
      message: "Make this shorter",
      selectedSlideId: "slide_1",
      selectedElementIds: ["shape_body"],
    },
  });

  assert.equal(response.statusCode, 200, response.body);
  const body = response.json() as {
    proposalPreview: { targetRefs: string[] };
  };
  assert.deepEqual(body.proposalPreview.targetRefs, ["slide_1.shape_body"]);
});

test("invalid selected element id does not create an invalid plan", async (t) => {
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
      message: "Make this better",
      selectedSlideId: "slide_1",
      selectedElementIds: ["missing_shape"],
    },
  });

  assert.equal(response.statusCode, 200, response.body);
  const body = response.json() as {
    uiState: string;
    proposalPreview?: { targetRefs: string[] };
    decisionRequest: { purpose: string; inputMode: string };
  };
  assert.equal(body.uiState, "ready");
  assert.equal(body.proposalPreview, undefined);
  assert.equal(body.decisionRequest.purpose, "choose_target");
  assert.equal(body.decisionRequest.inputMode, "single_choice");
});

test("ambiguous target request returns clarification instead of guessing title", async (t) => {
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
      message: "Make this better",
      selectedSlideId: "slide_1",
      selectedElementIds: [],
    },
  });

  assert.equal(response.statusCode, 200, response.body);
  const body = response.json() as {
    uiState: string;
    editPlan?: unknown;
    proposalPreview?: unknown;
    decisionRequest: { kind: string; purpose: string; inputMode: string };
  };
  assert.equal(body.uiState, "ready");
  assert.equal(body.editPlan, undefined);
  assert.equal(body.proposalPreview, undefined);
  assert.equal(body.decisionRequest.kind, "clarification");
  assert.equal(body.decisionRequest.purpose, "choose_target");
  assert.equal(body.decisionRequest.inputMode, "single_choice");
});

test("explicit slide reference can resolve outside the selected slide", async (t) => {
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
      message: "Change slide 2 title to Hello World",
      selectedSlideId: "slide_1",
      selectedElementIds: [],
    },
  });

  assert.equal(response.statusCode, 200, response.body);
  const body = response.json() as {
    editPlan: { affectedSlides: string[]; operations: Array<{ targetRef: string }> };
  };
  assert.deepEqual(body.editPlan.affectedSlides, ["slide_2"]);
  assert.equal(body.editPlan.operations[0]?.targetRef, "slide_2.shape_title");
});

test("operation menu exposes only implemented operations for slide and text targets", async (t) => {
  const { app, dataDir, deckId } = await createReadyDeck();
  t.after(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(`${dataDir}-root-data`, { recursive: true, force: true });
  });

  const graph = readStoredGraph(dataDir, deckId, "v1");
  const menu = buildOperationMenu(graph, "slide_1");
  const background = menu.targets.find((target) => target.targetRef === "slide_1.background");
  const title = menu.targets.find((target) => target.targetRef === "slide_1.shape_title");

  assert.ok(background);
  assert.deepEqual(
    background.allowedOperations.map((operation) => operation.operationType),
    ["set_slide_background"],
  );
  assert.ok(title);
  assert.deepEqual(
    title.allowedOperations.map((operation) => operation.operationType),
    ["replace_text"],
  );
  assert.equal(
    menu.targets
      .flatMap((target) => target.allowedOperations)
      .some((operation) => String(operation.operationType) === "apply_style_ref"),
    false,
  );
});

test("operation registry rejects invalid target, operation, and args", async (t) => {
  const { app, dataDir, deckId } = await createReadyDeck();
  t.after(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(`${dataDir}-root-data`, { recursive: true, force: true });
  });

  const graph = readStoredGraph(dataDir, deckId, "v1");
  const menu = buildOperationMenu(graph, "slide_1");

  assert.throws(
    () =>
      validateOperationSelection(
        {
          targetRef: "slide_1.missing",
          operationType: "replace_text",
          args: { text: "Hello" },
          confidence: 0.9,
          reason: "bad target",
          needsClarification: false,
        },
        menu,
      ),
    /Target is not in the operation menu/,
  );
  assert.throws(
    () =>
      validateOperationSelection(
        {
          targetRef: "slide_1.background",
          operationType: "replace_text",
          args: { text: "Hello" },
          confidence: 0.9,
          reason: "bad op",
          needsClarification: false,
        },
        menu,
      ),
    /not allowed/,
  );
  assert.throws(
    () =>
      validateOperationSelection(
        {
          targetRef: "slide_1.background",
          operationType: "set_slide_background",
          args: { color: "blue" },
          confidence: 0.9,
          reason: "bad args",
          needsClarification: false,
        },
        menu,
      ),
    /six-digit hex/,
  );
});

test("registry text replacement patches only the resolved shape subtree", () => {
  const dataDir = tempDataDir();
  const extractedPath = join(dataDir, "extracted");
  const slideDir = join(extractedPath, "ppt", "slides");
  mkdirSync(slideDir, { recursive: true });
  const slidePath = join(slideDir, "slide1.xml");
  writeFileSync(
    slidePath,
    `<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree>
    <p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/></p:nvSpPr><p:txBody><a:p><a:r><a:t>Duplicate</a:t></a:r></a:p></p:txBody></p:sp>
    <p:sp><p:nvSpPr><p:cNvPr id="3" name="Body"/></p:nvSpPr><p:txBody><a:p><a:r><a:t>Duplicate</a:t></a:r></a:p></p:txBody></p:sp>
  </p:spTree></p:cSld>
</p:sld>`,
  );
  const repo = {
    getElementByTargetRef() {
      return {
        slideId: "slide_1",
        elementId: "shape_title",
        elementType: "text_box",
        role: "title",
        text: "Duplicate",
        bounds: { x: 0, y: 0, w: 1, h: 1 },
        style: {},
        xmlProvenance: {
          part: "ppt/slides/slide1.xml",
          shapeId: "3",
          shapeName: "Title",
        },
      };
    },
  };

  const changedSlides = applyRegistryOperations({
    repo: repo as any,
    presentationId: "deck_test",
    sourceVersionId: "v1",
    extractedPath,
    plan: {
      planId: "plan_test",
      planType: "edit",
      deckId: "deck_test",
      createdFromVersionId: "v1",
      status: "approved",
      summary: "Scoped duplicate replacement",
      affectedSlides: ["slide_1"],
      operations: [
        {
          operationId: "op_test",
          operationType: "replace_text",
          targetRef: "slide_1.shape_title",
          humanLabel: "title",
          before: "Duplicate",
          after: "Changed",
          preserveStyle: true,
          preserveBounds: true,
        },
      ],
      risks: [],
      requiresApproval: true,
    },
  });

  const xml = readFileSync(slidePath, "utf8");
  assert.deepEqual(changedSlides, ["slide_1"]);
  assert.match(xml, /id="2"[\s\S]*<a:t>Duplicate<\/a:t>/);
  assert.match(xml, /id="3"[\s\S]*<a:t>Changed<\/a:t>/);
  rmSync(dataDir, { recursive: true, force: true });
});

test("slide background color request creates a slide-level preview and applies OOXML", async (t) => {
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
      message: "Change the background color to blue.",
      selectedSlideId: "slide_1",
      selectedElementIds: [],
    },
  });

  assert.equal(response.statusCode, 200, response.body);
  const body = response.json() as {
    uiState: string;
    editPlan: {
      affectedSlides: string[];
      operations: Array<{ operationType: string; targetRef: string; after: string }>;
    };
    proposalPreview: { slideId: string; targetRefs: string[]; renderUrl?: string };
    decisionRequest: { decisionId: string };
  };
  assert.equal(body.uiState, "awaiting_plan_approval");
  assert.deepEqual(body.editPlan.affectedSlides, ["slide_1"]);
  assert.equal(body.editPlan.operations[0]?.operationType, "set_slide_background");
  assert.equal(body.editPlan.operations[0]?.targetRef, "slide_1.background");
  assert.equal(body.editPlan.operations[0]?.after, "0000FF");
  assert.deepEqual(body.proposalPreview.targetRefs, ["slide_1.background"]);
  assert.ok(body.proposalPreview.renderUrl);

  const decisionResponse = await app.inject({
    method: "POST",
    url: `/api/decks/${deckId}/decisions/${body.decisionRequest.decisionId}/respond`,
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
  assert.equal((job.json() as JobStatus).status, "succeeded");

  const slideXml = readFileSync(
    join(
      dataDir,
      "projects",
      "project_local",
      "presentations",
      deckId,
      "versions",
      "v2",
      "extracted",
      "ppt",
      "slides",
      "slide1.xml",
    ),
    "utf8",
  );
  assert.match(slideXml, /<p:bg>/);
  assert.match(slideXml, /<a:srgbClr val="0000FF"\/>/);
});

test("registry rejects a stale before text plan", async (t) => {
  const { app, dataDir, deckId } = await createReadyDeck();
  t.after(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(`${dataDir}-root-data`, { recursive: true, force: true });
  });

  const graph = readStoredGraph(dataDir, deckId, "v1");
  assert.throws(
    () =>
      validatePlanAgainstRegistry(
        {
          planId: "plan_bad",
          planType: "edit",
          deckId,
          createdFromVersionId: "v1",
          status: "awaiting_approval",
          summary: "Invalid stale edit plan.",
          affectedSlides: ["slide_1"],
          operations: [
            {
              operationId: "op_bad",
              operationType: "replace_text",
              targetRef: "slide_1.shape_title",
              humanLabel: "Bad stale edit",
              before: "Not the current text",
              after: "Hello World",
              preserveStyle: true,
              preserveBounds: true,
            },
          ],
          risks: [],
          requiresApproval: true,
        },
        graph,
      ),
    /before text does not match/,
  );
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
      decisionRequest?: unknown;
    };
  };
  assert.equal(jobBody.status, "succeeded");
  assert.equal(jobBody.result.reviewResult.outputVersionId, "v2");
  assert.equal(jobBody.result.deckStatus.activeVersionId, "v2");
  assert.equal(jobBody.result.deckStatus.versions.find((version) => version.id === "v2")?.status, "edited");
  assert.equal(jobBody.result.deckStatus.validationSummary.canExport, true);
  assert.ok(jobBody.result.reviewResult.slidePreviews[0]?.after.renderUrl);
  assert.equal(jobBody.result.decisionRequest, undefined);
  assert.equal(
    jobBody.result.events.some(
      (event) => event.type === "tool_start" && event.chip.verb === "accept_version",
    ),
    false,
  );
  assertReasoningEvents(jobBody.result.events, [
    "Applying the approved edit.",
    "Rendering the updated slide.",
    "Validating the changed slide.",
  ]);
  assert.equal(readFinalChangeEvents(proprietaryDataDir).length, 0);

  const exported = await app.inject({
    method: "POST",
    url: `/api/decks/${deckId}/versions/v2/export`,
    payload: {},
  });
  assert.equal(exported.statusCode, 200, exported.body);
  const exportBody = exported.json() as {
    uiState: string;
    exportArtifact: { status: string; downloadUrl: string };
  };
  assert.equal(exportBody.uiState, "review_ready");
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

test("restoring parent version undoes the applied draft", async (t) => {
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
  const applyJobBody = applyJob.json() as JobStatus & { result: { deckStatus: DeckStatus } };
  assert.equal(applyJobBody.status, "succeeded");
  assert.equal(applyJobBody.result.deckStatus.activeVersionId, "v2");
  assert.equal(applyJobBody.result.deckStatus.parentVersionId, "v1");

  const restored = await app.inject({
    method: "POST",
    url: `/api/decks/${deckId}/versions/v1/restore`,
    payload: {},
  });
  assert.equal(restored.statusCode, 200, restored.body);
  assert.equal((restored.json() as { deckStatus: DeckStatus }).deckStatus.activeVersionId, "v1");
  assert.equal(readFinalChangeEvents(proprietaryDataDir).length, 0);
});

function readFinalChangeEvents(proprietaryDataDir: string): Array<Record<string, any>> {
  return finalChangeEventFiles(proprietaryDataDir).map((file) =>
    JSON.parse(readFileSync(file, "utf8")) as Record<string, any>,
  );
}

function readStoredGraph(dataDir: string, deckId: string, versionId: string): CanonicalGraph {
  return JSON.parse(
    readFileSync(
      join(
        dataDir,
        "projects",
        "project_local",
        "presentations",
        deckId,
        "versions",
        versionId,
        "graph.json",
      ),
      "utf8",
    ),
  ) as CanonicalGraph;
}

function assertReasoningEvents(events: AgentEvent[], expectedTexts: string[]): void {
  const reasoning = events.filter((event) => event.type === "reasoning");
  const texts = reasoning.map((event) => event.text);
  for (const expectedText of expectedTexts) {
    assert.ok(texts.includes(expectedText), `Missing reasoning event: ${expectedText}`);
  }
  for (const event of reasoning) {
    assert.ok(event.text.split(/\s+/).length <= 60, `Reasoning is too long: ${event.text}`);
  }
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
