import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import Fastify, { type FastifyInstance } from "fastify";
import { createReadStream, readFileSync } from "node:fs";
import { basename } from "node:path";
import { ArtifactStore } from "./artifact-store.js";
import { loadConfig, type AppConfig } from "./config.js";
import { AppDatabase } from "./database.js";
import { badRequest } from "./errors.js";
import { OpenAIPlanner, type Planner } from "./planner.js";
import { ProprietaryDataStore } from "./proprietary-data-store.js";
import { SQLiteRepository } from "./repository.js";
import { OpenAITargetResolver, type TargetResolver } from "./target-resolver.js";
import type { DecisionResponse, RequestEditInput } from "./types.js";
import { loadSamplePptx, WorkflowService } from "./workflow.js";

export type BuildAppOptions = {
  logger?: boolean;
  jobDurationMs?: number;
  dataDir?: string;
  config?: Partial<AppConfig>;
  planner?: Planner;
  targetResolver?: TargetResolver;
};

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });
  const config = loadConfig({
    ...options.config,
    dataDir: options.dataDir ?? options.config?.dataDir,
  });
  const database = new AppDatabase(config.databasePath);
  const repo = new SQLiteRepository(database);
  const store = new ArtifactStore(config.dataDir);
  const proprietaryDataStore = new ProprietaryDataStore(config.proprietaryDataDir);
  const workflow = new WorkflowService({
    config,
    repo,
    store,
    proprietaryDataStore,
    planner: options.planner ?? new OpenAIPlanner(config),
    targetResolver: options.targetResolver ?? new OpenAITargetResolver(config),
  });

  app.register(cors, {
    origin: ["http://localhost:3000", "http://127.0.0.1:3000"],
  });
  app.register(multipart);

  app.addHook("onClose", async () => {
    repo.close();
  });

  app.setErrorHandler((error, _request, reply) => {
    const err = error as { statusCode?: unknown; code?: unknown; message?: string };
    const statusCode = typeof err.statusCode === "number" ? err.statusCode : 500;
    const code = typeof err.code === "string" ? err.code : "INTERNAL_ERROR";
    reply.code(statusCode).send({
      error: {
        code,
        message: err.message ?? "Unexpected backend error.",
      },
    });
  });

  app.get("/health", async () => ({ ok: true }));

  app.get("/api/workspace/current", async () => {
    return workflow.getCurrentWorkspace();
  });

  app.post("/api/decks/upload", async (request) => {
    let fileName: string;
    let bytes: Buffer;
    if (request.isMultipart()) {
      const file = await request.file();
      if (!file) throw badRequest("FILE_REQUIRED", "A .pptx file is required.");
      fileName = file.filename;
      bytes = await file.toBuffer();
    } else {
      const sample = loadSamplePptx();
      fileName = sample.fileName;
      bytes = sample.bytes;
    }
    return workflow.createUpload(fileName, bytes);
  });

  app.get<{ Params: { jobId: string } }>("/api/jobs/:jobId", async (request) => {
    return workflow.getJobStatus(request.params.jobId);
  });

  app.get<{ Params: { deckId: string } }>("/api/decks/:deckId/status", async (request) => {
    return workflow.getDeckStatus(request.params.deckId);
  });

  app.get<{ Params: { deckId: string } }>("/api/decks/:deckId/threads", async (request) => {
    return workflow.listThreads(request.params.deckId);
  });

  app.post<{ Params: { deckId: string } }>("/api/decks/:deckId/threads", async (request) => {
    return workflow.createThread(request.params.deckId);
  });

  app.get<{ Params: { artifactId: string } }>("/api/artifacts/:artifactId", async (request, reply) => {
    const artifact = repo.getArtifact(request.params.artifactId);
    if (!artifact) throw badRequest("ARTIFACT_NOT_FOUND", "Artifact not found.");
    reply.type(artifact.contentType);
    if (artifact.contentType.includes("image/svg+xml")) {
      return reply.send(stripBackendRenderDebug(readFileSync(artifact.path, "utf8")));
    }
    if (artifact.type === "export") {
      reply.header("content-disposition", `attachment; filename="${basename(artifact.path)}"`);
    }
    return reply.send(createReadStream(artifact.path));
  });

  app.post<{ Params: { deckId: string }; Body: Omit<RequestEditInput, "deckId"> }>(
    "/api/decks/:deckId/edit-requests",
    async (request) => {
      return workflow.requestEdit({
        ...request.body,
        deckId: request.params.deckId,
      });
    },
  );

  app.post<{ Params: { deckId: string; decisionId: string }; Body: DecisionResponse }>(
    "/api/decks/:deckId/decisions/:decisionId/respond",
    async (request) => {
      return workflow.respondToDecision(
        request.params.deckId,
        request.params.decisionId,
        request.body,
      );
    },
  );

  app.post<{ Params: { deckId: string; versionId: string } }>(
    "/api/decks/:deckId/versions/:versionId/accept",
    async (request) => {
      return workflow.acceptVersion(request.params.deckId, request.params.versionId);
    },
  );

  app.post<{ Params: { deckId: string; versionId: string }; Body: { restoreVersionId?: string } }>(
    "/api/decks/:deckId/versions/:versionId/reject",
    async (request) => {
      return workflow.rejectVersion(
        request.params.deckId,
        request.params.versionId,
        request.body?.restoreVersionId,
      );
    },
  );

  app.post<{ Params: { deckId: string; versionId: string } }>(
    "/api/decks/:deckId/versions/:versionId/restore",
    async (request) => {
      return workflow.restoreVersion(request.params.deckId, request.params.versionId);
    },
  );

  app.post<{ Params: { deckId: string; versionId: string } }>(
    "/api/decks/:deckId/versions/:versionId/export",
    async (request) => {
      return workflow.exportVersion(request.params.deckId, request.params.versionId);
    },
  );

  return app;
}

function stripBackendRenderDebug(svg: string): string {
  return svg.replace(
    /\n\s*<line[^>]*stroke="#e5e7eb"[^>]*>\s*\n\s*<text[^>]*>Backend SVG render · [^<]*<\/text>/,
    "",
  );
}
