import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ArtifactStore } from "./artifact-store.js";
import type { AppConfig } from "./config.js";
import { badRequest, conflict, notFound } from "./errors.js";
import { makeId } from "./ids.js";
import { HeuristicPlanner, type Planner } from "./planner.js";
import {
  ProprietaryDataStore,
  type FinalChangeDecision,
} from "./proprietary-data-store.js";
import { assertPptx, parsePresentationGraph } from "./pptx-parser.js";
import type {
  AgentEvent,
  DecisionRequest,
  DecisionResponse,
  DeckStatus,
  EditOperation,
  EditPlan,
  ExportArtifact,
  JobStatus,
  ProcessingProgress,
  ProposalPreview,
  RequestEditInput,
  ReviewResult,
  ThreadSummary,
  ToolChip,
} from "./types.js";
import {
  type CanonicalGraph,
  type GraphSlide,
  SQLiteRepository,
  type StoredDecision,
} from "./repository.js";
import { renderGraphSlides, slideToSvg } from "./svg-renderer.js";
import {
  applyRegistryOperations,
  buildOperationMenu,
  HeuristicOperationSelector,
  menuTargetsForClarification,
  OpenAIOperationSelector,
  planFromSelection,
  previewPlanOnGraph,
  validatePlanAgainstRegistry,
  type OperationSelector,
  type OperationSelection,
} from "./operation-registry.js";
import {
  HeuristicTargetResolver,
  type TargetResolver,
} from "./target-resolver.js";
import { validateVersion } from "./validator.js";

type WorkflowOptions = {
  config: AppConfig;
  repo: SQLiteRepository;
  store: ArtifactStore;
  proprietaryDataStore: ProprietaryDataStore;
  planner?: Planner;
  targetResolver?: TargetResolver;
  operationSelector?: OperationSelector;
};

const completeProgress: ProcessingProgress = {
  upload: 100,
  parse: 100,
  render: 100,
  validate: 100,
};

export class WorkflowService {
  private readonly planner: Planner;
  private readonly targetResolver: TargetResolver;
  private readonly operationSelector: OperationSelector;

  constructor(private readonly options: WorkflowOptions) {
    this.planner = options.planner ?? new HeuristicPlanner();
    this.targetResolver = options.targetResolver ?? new HeuristicTargetResolver();
    this.operationSelector =
      options.operationSelector ??
      (options.config.openaiApiKey
        ? new OpenAIOperationSelector(options.config)
        : new HeuristicOperationSelector());
  }

  createUpload(fileName: string, bytes: Buffer): { deckId: string; jobId: string; uiState: "processing" } {
    assertPptx(bytes);
    const deckId = makeId("deck");
    const safeName = normalizeFileName(fileName);

    this.options.store.writeOriginal(deckId, bytes);
    this.options.store.createOriginalExtraction(deckId);
    this.options.store.createInitialVersion(deckId);

    this.options.repo.createPresentation({
      id: deckId,
      fileName: safeName,
      originalVersionId: "original",
      activeVersionId: "v1",
    });

    const originalGraphPath = resolve(
      this.options.store.presentationDir(deckId),
      "original",
      "graph.json",
    );
    this.options.repo.saveVersion({
      presentationId: deckId,
      versionId: "original",
      parentVersionId: null,
      versionNumber: 0,
      status: "original",
      filePath: this.options.store.originalPptxPath(deckId),
      extractedPath: this.options.store.originalExtractedPath(deckId),
      graphPath: originalGraphPath,
      createdByPlanId: null,
    });
    this.options.repo.saveVersion({
      presentationId: deckId,
      versionId: "v1",
      parentVersionId: "original",
      versionNumber: 1,
      status: "working",
      filePath: this.options.store.versionPptxPath(deckId, "v1"),
      extractedPath: this.options.store.versionExtractedPath(deckId, "v1"),
      graphPath: this.options.store.versionGraphPath(deckId, "v1"),
      createdByPlanId: null,
    });

    const originalGraph = parsePresentationGraph({
      presentationId: deckId,
      versionId: "original",
      extractedPath: this.options.store.originalExtractedPath(deckId),
    });
    this.options.store.writeJson(originalGraphPath, originalGraph);
    this.processVersion(deckId, "v1");

    const jobId = this.saveSucceededJob({
      deckId,
      versionId: "v1",
      jobType: "upload_process",
      result: { next: "fetch_deck_status" },
    });
    return { deckId, jobId, uiState: "processing" };
  }

  getDeckStatus(deckId: string): DeckStatus {
    if (!this.options.repo.getPresentation(deckId)) {
      throw notFound("DECK_NOT_FOUND", "Deck not found.");
    }
    return this.options.repo.deckStatus(deckId);
  }

  getCurrentWorkspace(): { deckStatus: DeckStatus | null } {
    const latest = this.options.repo.getLatestPresentation();
    return { deckStatus: latest ? this.getDeckStatus(latest.id) : null };
  }

  listThreads(deckId: string): { threads: ThreadSummary[] } {
    this.getDeckStatus(deckId);
    return { threads: this.options.repo.listThreads(deckId) };
  }

  createThread(deckId: string): { thread: ThreadSummary } {
    this.getDeckStatus(deckId);
    const nextNumber = this.options.repo.listThreads(deckId).length + 1;
    return {
      thread: this.options.repo.createThread(deckId, `Thread ${nextNumber}`),
    };
  }

  getJobStatus(jobId: string): JobStatus {
    const job = this.options.repo.getJob(jobId);
    if (!job) throw notFound("JOB_NOT_FOUND", "Job not found.");
    return publicJob(job);
  }

  async requestEdit(input: RequestEditInput): Promise<{
    uiState: "awaiting_plan_approval" | "ready";
    events: AgentEvent[];
    editPlan?: EditPlan;
    decisionRequest: DecisionRequest;
    proposalPreview?: ProposalPreview;
    threadId: string;
  }> {
    const deck = this.getDeckStatus(input.deckId);
    if (deck.activeVersionId !== input.versionId) {
      throw conflict("STALE_VERSION", "The deck changed. Replan from the active version.");
    }

    const threadId = input.threadId
      ? this.requireRequestThread(input.deckId, input.threadId)
      : this.options.repo.ensureThread(input.deckId);
    this.options.repo.saveThreadMessage(threadId, "user", input.message);

    const graph = this.readGraph(input.deckId, input.versionId);
    const currentSlideId = explicitSlideId(input.message, graph) ?? input.selectedSlideId ?? graph.slides[0]?.slideId;
    if (!currentSlideId) throw conflict("TARGET_NOT_FOUND", "No slide was available for operation planning.");
    const operationMenu = buildOperationMenu(graph, currentSlideId);
    const selectedOperation = await this.operationSelector.selectOperation({
      message: input.message,
      menu: operationMenu,
      selectedElementIds: input.selectedElementIds,
    });
    if (
      selectedOperation.needsClarification ||
      !selectedOperation.targetRef ||
      !selectedOperation.operationType ||
      selectedOperation.confidence < 0.75
    ) {
      const options = menuTargetsForClarification(operationMenu);
      const decision = this.createDecision({
        deckId: input.deckId,
        versionId: input.versionId,
        threadId,
        action: "clarify_target",
        purpose: "choose_target",
        sourceVersionId: input.versionId,
        subjectVersionId: input.versionId,
        kind: "clarification",
        title: "Which object should I edit?",
        question:
          selectedOperation.clarificationQuestion ??
          "Which slide object should I edit?",
        context: selectedOperation.reason,
        inputMode: "single_choice",
        options,
        defaultOptionId: options[0]?.id,
      });
      this.options.repo.saveThreadMessage(
        threadId,
        "assistant",
        "I need a specific edit target before preparing the preview.",
      );
      return {
        uiState: "ready",
        events: createClarificationEvents(input.message, decision, selectedOperation),
        decisionRequest: stripDecision(decision),
        threadId,
      };
    }

    const plan = planFromSelection({
      deckId: input.deckId,
      versionId: input.versionId,
      selection: selectedOperation,
      menu: operationMenu,
      graph,
    });
    assertSelectedSlideScope(plan, currentSlideId, input.message);
    validatePlanAgainstRegistry(plan, graph);
    this.options.repo.savePlan({ ...plan, threadId, userPrompt: input.message });

    const decision = this.createDecision({
      deckId: input.deckId,
      versionId: input.versionId,
      planId: plan.planId,
      threadId,
      action: "apply_plan",
      purpose: "confirm_risk",
      sourceVersionId: input.versionId,
      subjectVersionId: input.versionId,
      kind: "approval",
      title: `Apply edit plan to ${input.versionId}`,
      question: `Apply this ${plan.operations.length}-operation edit plan?`,
      context: plan.summary,
      inputMode: "yes_no",
      options: [
        {
          id: "apply",
          label: "Apply edit",
          description: "Create a new version and run validation.",
        },
        {
          id: "reject",
          label: "Reject",
          description: "Return to the prompt without changing the deck.",
        },
      ],
      defaultOptionId: "apply",
    });
    const proposalPreview = this.createProposalPreview(
      input.deckId,
      input.versionId,
      plan,
      decision.decisionId,
    );
    this.options.repo.saveThreadMessage(threadId, "assistant", plan.summary);

    return {
      uiState: "awaiting_plan_approval",
      events: createPlanEvents(input.message, input.versionId, plan, decision, selectedOperation),
      editPlan: plan,
      decisionRequest: stripDecision(decision),
      proposalPreview,
      threadId,
    };
  }

  respondToDecision(deckId: string, decisionId: string, response: DecisionResponse) {
    const deck = this.getDeckStatus(deckId);
    const decision = this.options.repo.getDecision(decisionId);
    if (!decision || decision.deckId !== deckId) {
      throw notFound("DECISION_NOT_FOUND", "Decision not found.");
    }
    if (decision.status !== "awaiting") {
      throw conflict("DECISION_CLOSED", "Decision has already been answered.");
    }
    if (decision.versionId !== response.versionId) {
      throw conflict("STALE_DECISION", "Decision was created for a different version.");
    }

    if (decision.action === "apply_plan") {
      return this.respondToApplyDecision(deck, decision, response);
    }
    if (decision.action === "clarify_target") {
      this.options.repo.saveDecision({ ...decision, status: "answered" });
      if (decision.threadId) {
        this.options.repo.saveThreadMessage(
          decision.threadId,
          "user",
          response.answerText ?? response.selectedOptionId ?? "",
        );
        this.options.repo.saveThreadMessage(
          decision.threadId,
          "assistant",
          "Target clarified. Submit the edit instruction again to preview the change.",
        );
      }
      return {
        uiState: "ready" as const,
        events: clarifyTargetResolvedEvents(decision.decisionId),
        deckStatus: deck,
      };
    }
    return this.respondToAcceptDecision(deck, decision, response);
  }

  acceptVersion(deckId: string, versionId: string): { uiState: "accepted"; deckStatus: DeckStatus } {
    const deck = this.getDeckStatus(deckId);
    if (deck.activeVersionId !== versionId) {
      throw conflict("STALE_VERSION", "Only the active version can be accepted.");
    }
    if (!deck.validationSummary.canAccept) {
      throw conflict("ACCEPT_BLOCKED", "Backend validation has not allowed accept.");
    }
    this.options.repo.markVersionStatus(deckId, versionId, "accepted");
    return { uiState: "accepted", deckStatus: this.getDeckStatus(deckId) };
  }

  rejectVersion(deckId: string, versionId: string, restoreVersionId?: string): { uiState: "ready"; deckStatus: DeckStatus } {
    this.getDeckStatus(deckId);
    this.options.repo.markVersionStatus(deckId, versionId, "rejected");
    this.options.repo.updatePresentationActiveVersion(deckId, restoreVersionId ?? "v1");
    return { uiState: "ready", deckStatus: this.getDeckStatus(deckId) };
  }

  restoreVersion(deckId: string, versionId: string): { uiState: "ready"; deckStatus: DeckStatus } {
    this.getDeckStatus(deckId);
    if (!this.options.repo.getVersion(deckId, versionId)) {
      throw notFound("VERSION_NOT_FOUND", "Version not found.");
    }
    this.options.repo.updatePresentationActiveVersion(deckId, versionId);
    return { uiState: "ready", deckStatus: this.getDeckStatus(deckId) };
  }

  exportVersion(deckId: string, versionId: string): {
    uiState: "accepted" | "review_ready";
    exportArtifact: ExportArtifact;
    deckStatus: DeckStatus;
  } {
    const deck = this.getDeckStatus(deckId);
    if (deck.activeVersionId !== versionId) {
      throw conflict("STALE_VERSION", "Only the active version can be exported.");
    }
    if (!deck.validationSummary.canExport) {
      throw conflict("EXPORT_BLOCKED", "Backend validation has not allowed export.");
    }
    const exportPath = this.options.store.copyExport(deckId, versionId, deck.fileName);
    const artifact = this.options.repo.saveArtifact({
      presentationId: deckId,
      versionId,
      type: "export",
      path: exportPath,
      contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      slideId: null,
    });
    const exportArtifact = this.options.repo.saveExport({
      presentationId: deckId,
      versionId,
      filePath: exportPath,
      artifactId: artifact.id,
    });
    const status = this.getDeckStatus(deckId);
    const accepted = status.versions.some(
      (version) => version.id === versionId && version.status === "accepted",
    );
    return {
      uiState: accepted ? "accepted" : "review_ready",
      exportArtifact,
      deckStatus: status,
    };
  }

  private respondToApplyDecision(
    deck: DeckStatus,
    decision: StoredDecision,
    response: DecisionResponse,
  ) {
    this.options.repo.saveDecision({ ...decision, status: "answered" });
    const plan = decision.planId ? this.options.repo.getPlan(decision.planId) : undefined;
    if (!plan) throw notFound("PLAN_NOT_FOUND", "Edit plan not found.");
    if (plan.createdFromVersionId !== deck.activeVersionId) {
      throw conflict("STALE_PLAN", "The deck changed after this plan was created.");
    }

    if (response.selectedOptionId !== "apply") {
      this.options.repo.updatePlanStatus(plan.planId, "rejected");
      this.saveDecisionAssistantMessage(decision, "Rejected the pending edit preview.");
      return {
        uiState: "ready" as const,
        events: rejectPlanEvents(decision.decisionId),
        deckStatus: deck,
      };
    }

    this.options.repo.updatePlanStatus(plan.planId, "approved");
    const reviewResult = this.applyPlan(deck.deckId, plan, decision.decisionId);
    this.saveDecisionAssistantMessage(
      decision,
      `Applied ${plan.planId} and created ${reviewResult.outputVersionId}.`,
    );
    const jobId = this.saveSucceededJob({
      deckId: deck.deckId,
      versionId: reviewResult.outputVersionId,
      jobType: "apply_plan",
      result: reviewResult.jobResult,
    });
    return {
      uiState: "editing" as const,
      jobId,
      events: [
        {
          type: "tool_update",
          chipId: decision.decisionId,
          patch: { status: "submitting" },
        },
      ] satisfies AgentEvent[],
    };
  }

  private respondToAcceptDecision(
    deck: DeckStatus,
    decision: StoredDecision,
    response: DecisionResponse,
  ) {
    if (response.selectedOptionId === "refine") {
      this.options.repo.saveDecision({ ...decision, status: "answered" });
      this.saveDecisionAssistantMessage(
        decision,
        `Kept ${deck.activeVersionId} active for further refinement.`,
      );
      return {
        uiState: "ready" as const,
        events: refineVersionEvents(decision.decisionId),
        deckStatus: this.getDeckStatus(deck.deckId),
      };
    }
    if (response.selectedOptionId === "reject") {
      this.captureFinalReviewDecision(deck, decision, "rejected");
      this.options.repo.saveDecision({ ...decision, status: "answered" });
      const restoreVersion = deck.parentVersionId ?? "v1";
      this.options.repo.markVersionStatus(deck.deckId, deck.activeVersionId, "rejected");
      this.options.repo.updatePresentationActiveVersion(deck.deckId, restoreVersion);
      this.saveDecisionAssistantMessage(
        decision,
        `Rejected ${deck.activeVersionId} and restored ${restoreVersion}.`,
      );
      return {
        uiState: "ready" as const,
        events: rejectVersionEvents(decision.decisionId),
        deckStatus: this.getDeckStatus(deck.deckId),
      };
    }
    if (response.selectedOptionId !== "accept") {
      throw badRequest("INVALID_DECISION_RESPONSE", "Select accept, refine, or reject.");
    }
    if (!deck.validationSummary.canAccept) {
      throw conflict("ACCEPT_BLOCKED", "Backend validation has not allowed accept.");
    }
    this.captureFinalReviewDecision(deck, decision, "accepted");
    this.options.repo.saveDecision({ ...decision, status: "answered" });
    this.options.repo.markVersionStatus(deck.deckId, deck.activeVersionId, "accepted");
    this.saveDecisionAssistantMessage(decision, `Accepted ${deck.activeVersionId}.`);
    return {
      uiState: "accepted" as const,
      events: acceptVersionEvents(decision.decisionId, deck.activeVersionId),
      deckStatus: this.getDeckStatus(deck.deckId),
    };
  }

  private applyPlan(deckId: string, plan: EditPlan, applyDecisionId: string): {
    outputVersionId: string;
    jobResult: {
      reviewResult: ReviewResult;
      deckStatus: DeckStatus;
      events: AgentEvent[];
    };
  } {
    const nextVersionId = this.options.repo.nextVersionId(deckId);
    const sourceVersion = this.options.repo.requireVersion(deckId, plan.createdFromVersionId);
    this.options.store.createVersionFromSource(deckId, sourceVersion.versionId, nextVersionId);
    const nextExtractedPath = this.options.store.versionExtractedPath(deckId, nextVersionId);
    const sourceGraph = this.readGraph(deckId, sourceVersion.versionId);
    validatePlanAgainstRegistry(plan, sourceGraph);
    const changedSlides = applyRegistryOperations({
      repo: this.options.repo,
      presentationId: deckId,
      sourceVersionId: sourceVersion.versionId,
      extractedPath: nextExtractedPath,
      plan,
    });
    this.options.store.packageVersion(deckId, nextVersionId);
    this.options.repo.saveVersion({
      presentationId: deckId,
      versionId: nextVersionId,
      parentVersionId: sourceVersion.versionId,
      versionNumber: Number(nextVersionId.replace(/^v/, "")),
      status: "edited",
      filePath: this.options.store.versionPptxPath(deckId, nextVersionId),
      extractedPath: nextExtractedPath,
      graphPath: this.options.store.versionGraphPath(deckId, nextVersionId),
      createdByPlanId: plan.planId,
    });
    this.processVersion(deckId, nextVersionId, changedSlides);
    for (const slideId of changedSlides) {
      this.options.repo.markSlideStatus(deckId, nextVersionId, slideId, "changed");
    }
    this.options.repo.updatePresentationActiveVersion(deckId, nextVersionId);
    this.options.repo.updatePlanStatus(plan.planId, "applied");

    const reviewResult = this.reviewResult(deckId, sourceVersion.versionId, nextVersionId, changedSlides);
    return {
      outputVersionId: nextVersionId,
      jobResult: {
        reviewResult,
        deckStatus: this.getDeckStatus(deckId),
        events: applyCompleteEvents(
          applyDecisionId,
          sourceVersion.versionId,
          nextVersionId,
          changedSlides,
          reviewResult.validationSummary.warningCount,
        ),
      },
    };
  }

  private processVersion(deckId: string, versionId: string, changedSlides: string[] = []): CanonicalGraph {
    const version = this.options.repo.requireVersion(deckId, versionId);
    const graph = parsePresentationGraph({
      presentationId: deckId,
      versionId,
      extractedPath: version.extractedPath,
    });
    this.options.store.writeJson(version.graphPath, graph);
    this.options.repo.replaceSlidesAndElements(graph);
    renderGraphSlides({ graph, repo: this.options.repo, store: this.options.store });
    validateVersion({ repo: this.options.repo, graph, changedSlides });
    return graph;
  }

  private reviewResult(
    deckId: string,
    inputVersionId: string,
    outputVersionId: string,
    changedSlides: string[],
  ): ReviewResult {
    const outputDeck = this.getDeckStatus(deckId);
    const inputSlides = this.options.repo.listSlides(deckId, inputVersionId);
    const outputSlides = this.options.repo.listSlides(deckId, outputVersionId);
    return {
      inputVersionId,
      outputVersionId,
      activeVersionId: outputVersionId,
      parentVersionId: inputVersionId,
      originalVersionId: outputDeck.originalVersionId,
      changedSlides,
      slideStatuses: outputDeck.slideStatuses,
      validationSummary: outputDeck.validationSummary,
      slidePreviews: changedSlides.map((slideId) => {
        const before = inputSlides.find((slide) => slide.slideId === slideId) ?? inputSlides[0];
        const after = outputSlides.find((slide) => slide.slideId === slideId) ?? outputSlides[0];
        return {
          slideId,
          before: {
            versionId: inputVersionId,
            title: before?.title ?? "Before",
            subtitle: before?.subtitle ?? "",
            renderUrl: this.artifactUrl(deckId, inputVersionId, "slide_render", slideId),
          },
          after: {
            versionId: outputVersionId,
            title: after?.title ?? "After",
            subtitle: after?.subtitle ?? "",
            renderUrl: this.artifactUrl(deckId, outputVersionId, "slide_render", slideId),
          },
        };
      }),
    };
  }

  private artifactUrl(
    deckId: string,
    versionId: string,
    type: string,
    slideId: string,
  ): string | undefined {
    const artifact = this.options.repo.findArtifact({
      presentationId: deckId,
      versionId,
      type,
      slideId,
    });
    return artifact ? `/api/artifacts/${artifact.id}` : undefined;
  }

  private createProposalPreview(
    deckId: string,
    versionId: string,
    plan: EditPlan,
    decisionId: string,
  ): ProposalPreview {
    const graph = this.readGraph(deckId, versionId);
    validatePlanAgainstRegistry(plan, graph);
    const { graph: previewGraph, highlightElementIds } = previewPlanOnGraph(plan, graph);

    const slideId = plan.affectedSlides[0] ?? targetSlideFromPlan(plan) ?? previewGraph.slides[0]?.slideId;
    if (!slideId) throw conflict("PREVIEW_TARGET_NOT_FOUND", "No slide was available for preview.");
    const slide = previewGraph.slides.find((candidate) => candidate.slideId === slideId);
    if (!slide) throw conflict("PREVIEW_TARGET_NOT_FOUND", "Preview slide was not found.");
    const previewPath = this.options.store.proposalPreviewPath(
      deckId,
      versionId,
      plan.planId,
      slideId,
    );
    this.options.store.writeText(
      previewPath,
      slideToSvg(slide, undefined, undefined, { highlightElementIds }),
    );
    const artifact = this.options.repo.saveArtifact({
      presentationId: deckId,
      versionId,
      type: "proposal_preview",
      path: previewPath,
      contentType: "image/svg+xml; charset=utf-8",
      slideId,
    });
    const targetRefs = [...new Set(plan.operations.map((operation) => operation.targetRef))];
    return {
      planId: plan.planId,
      decisionId,
      slideId,
      versionId,
      renderUrl: `/api/artifacts/${artifact.id}`,
      targetRefs,
      operations: plan.operations,
    };
  }

  private readGraph(deckId: string, versionId: string): CanonicalGraph {
    const version = this.options.repo.requireVersion(deckId, versionId);
    return JSON.parse(readFileSync(version.graphPath, "utf8")) as CanonicalGraph;
  }

  private createDecision(
    input: Omit<StoredDecision, "decisionId" | "required" | "blocksWorkflow" | "status">,
  ): StoredDecision {
    const decision: StoredDecision = {
      ...input,
      decisionId: makeId("decision"),
      required: true,
      blocksWorkflow: true,
      status: "awaiting",
    };
    this.options.repo.saveDecision(decision);
    return decision;
  }

  private requireRequestThread(deckId: string, threadId: string): string {
    const thread = this.options.repo.getThread(threadId);
    if (!thread || thread.presentationId !== deckId) {
      throw notFound("THREAD_NOT_FOUND", "Thread not found for this deck.");
    }
    if (thread.status !== "active") {
      throw conflict("THREAD_INACTIVE", "Only active threads can receive edit requests.");
    }
    return thread.id;
  }

  private saveDecisionAssistantMessage(decision: StoredDecision, content: string): void {
    if (!decision.threadId) return;
    this.options.repo.saveThreadMessage(decision.threadId, "assistant", content);
  }

  private saveSucceededJob(input: {
    deckId: string;
    versionId?: string;
    jobType: JobStatus["jobType"];
    result: unknown;
  }): string {
    const jobId = makeId("job");
    const timestamp = new Date().toISOString();
    this.options.repo.saveJob({
      jobId,
      deckId: input.deckId,
      versionId: input.versionId,
      jobType: input.jobType,
      status: "succeeded",
      progress: completeProgress,
      result: input.result,
      createdAt: timestamp,
      startedAt: timestamp,
      finishedAt: timestamp,
    });
    return jobId;
  }

  private captureFinalReviewDecision(
    deck: DeckStatus,
    decision: StoredDecision,
    finalDecision: FinalChangeDecision,
  ): void {
    if (decision.purpose !== "final_edit_review") return;
    if (!decision.planId) {
      throw conflict("CAPTURE_PLAN_MISSING", "Final edit review is missing its plan reference.");
    }
    const plan = this.options.repo.getPlan(decision.planId);
    if (!plan) throw notFound("PLAN_NOT_FOUND", "Edit plan not found.");

    const inputVersionId = decision.sourceVersionId ?? plan.createdFromVersionId;
    const outputVersionId = decision.subjectVersionId ?? decision.versionId;
    const editedVersion = this.options.repo.getVersion(deck.deckId, outputVersionId);
    if (!editedVersion) throw notFound("VERSION_NOT_FOUND", "Edited version not found.");
    if (
      editedVersion.createdByPlanId !== decision.planId ||
      editedVersion.status !== "edited" ||
      deck.activeVersionId !== outputVersionId
    ) {
      throw conflict(
        "CAPTURE_VERSION_INVALID",
        "Final edit feedback can only be captured for the active edited version created by this plan.",
      );
    }

    const changedSlideIds = plan.affectedSlides;
    const createdAt = new Date().toISOString();
    this.options.proprietaryDataStore.writeFinalChangeEvent({
      created_at: createdAt,
      decision: finalDecision,
      deck_id: deck.deckId,
      plan_id: plan.planId,
      decision_id: decision.decisionId,
      user_prompt: plan.userPrompt,
      input_version_id: inputVersionId,
      output_version_id: outputVersionId,
      changed_slide_ids: changedSlideIds,
      change_patch: plan.operations,
      before_state: this.slideStateSnapshot(deck.deckId, inputVersionId, changedSlideIds),
      after_state: this.slideStateSnapshot(deck.deckId, outputVersionId, changedSlideIds),
      render_artifacts: {
        before: this.renderArtifactSnapshots(deck.deckId, inputVersionId, changedSlideIds),
        after: this.renderArtifactSnapshots(deck.deckId, outputVersionId, changedSlideIds),
      },
      validation_summary: this.options.repo.validationSummary(deck.deckId, outputVersionId),
      provenance: {
        model_version: this.options.config.openaiModel,
        prompt_version: "slide_edit_v1",
      },
    });
  }

  private slideStateSnapshot(
    deckId: string,
    versionId: string,
    slideIds: string[],
  ): { version_id: string; slides: GraphSlide[] } {
    const version = this.options.repo.requireVersion(deckId, versionId);
    const graph = JSON.parse(readFileSync(version.graphPath, "utf8")) as CanonicalGraph;
    return {
      version_id: versionId,
      slides: graph.slides.filter((slide) => slideIds.includes(slide.slideId)),
    };
  }

  private renderArtifactSnapshots(
    deckId: string,
    versionId: string,
    slideIds: string[],
  ) {
    return slideIds.map((slideId) => {
      const artifact = this.options.repo.findArtifact({
        presentationId: deckId,
        versionId,
        type: "slide_render",
        slideId,
      });
      return {
        slide_id: slideId,
        version_id: versionId,
        artifact_id: artifact?.id,
        path: artifact?.path,
        url: artifact ? `/api/artifacts/${artifact.id}` : undefined,
      };
    });
  }
}

export function loadSamplePptx(): { fileName: string; bytes: Buffer } {
  const candidates = [
    resolve(process.cwd(), "sample.pptx"),
    resolve(process.cwd(), "..", "sample.pptx"),
  ];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (!path) throw badRequest("SAMPLE_NOT_FOUND", "sample.pptx was not found.");
  return { fileName: "sample.pptx", bytes: readFileSync(path) };
}

function normalizeFileName(fileName: string): string {
  const cleaned = fileName.split(/[\\/]/).pop()?.trim() || "presentation.pptx";
  return cleaned.toLowerCase().endsWith(".pptx") ? cleaned : `${cleaned}.pptx`;
}

function assertSelectedSlideScope(
  plan: EditPlan,
  selectedSlideId: string,
  message: string,
): void {
  if (allowsMultiSlideRequest(message)) return;
  const affectedSlides = new Set([
    ...plan.affectedSlides,
    ...plan.operations
      .map((operation) => targetSlideFromRef(operation.targetRef))
      .filter((slideId): slideId is string => Boolean(slideId)),
  ]);
  const unexpected = [...affectedSlides].filter((slideId) => slideId !== selectedSlideId);
  if (unexpected.length) {
    throw conflict(
      "SLIDE_SCOPE_MISMATCH",
      `The edit plan targeted ${unexpected.join(", ")} but the selected slide is ${selectedSlideId}.`,
    );
  }
}

function allowsMultiSlideRequest(message: string): boolean {
  return /\b(all|every|entire|whole|deck|presentation|multiple|slides)\b/i.test(message);
}

function explicitSlideId(message: string, graph: CanonicalGraph): string | undefined {
  const numeric = /\bslide\s+(\d+)\b/i.exec(message)?.[1];
  if (numeric) {
    const id = `slide_${Number(numeric)}`;
    return graph.slides.some((slide) => slide.slideId === id) ? id : undefined;
  }
  const word = /\bslide\s+(one|two|three|four|five|six|seven|eight|nine|ten)\b/i.exec(message)?.[1];
  if (word) {
    const number = wordToNumber(word);
    const id = `slide_${number}`;
    return graph.slides.some((slide) => slide.slideId === id) ? id : undefined;
  }
  return undefined;
}

function wordToNumber(value: string): number {
  const map: Record<string, number> = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
  };
  return map[value.toLowerCase()] ?? 0;
}

function targetSlideFromPlan(plan: EditPlan): string | undefined {
  return plan.operations
    .map((operation) => targetSlideFromRef(operation.targetRef))
    .find((slideId): slideId is string => Boolean(slideId));
}

function targetSlideFromRef(targetRef: string): string | undefined {
  return targetRef.split(".")[0] || undefined;
}

function publicJob(job: JobStatus): JobStatus {
  return {
    jobId: job.jobId,
    deckId: job.deckId,
    versionId: job.versionId,
    jobType: job.jobType,
    status: job.status,
    progress: job.progress,
    result: job.result,
    errorMessage: job.errorMessage,
  };
}

function stripDecision(decision: StoredDecision): DecisionRequest {
  const {
    action: _action,
    status: _status,
    threadId: _threadId,
    ...publicDecision
  } = decision;
  return publicDecision;
}

function createPlanEvents(
  message: string,
  versionId: string,
  plan: EditPlan,
  decision: StoredDecision,
  selection: OperationSelection,
): AgentEvent[] {
  const proseId = makeId("prose");
  const primaryOperation = plan.operations.find((op) => op.operationType !== "fit_text") ?? plan.operations[0];
  const targetRef = primaryOperation?.targetRef ?? selection.targetRef ?? "unknown";
  const slideId = targetSlideFromRef(targetRef) ?? plan.affectedSlides[0] ?? "slide";
  const operationSummaries = plan.operations
    .map((operation) => operation.preview)
    .filter((preview): preview is NonNullable<EditOperation["preview"]> => Boolean(preview));
  const resolveChip: ToolChip = {
    chipId: makeId("chip"),
    verb: "resolve_target",
    status: "done",
    icon: "check",
    title: "Resolve target",
    subtitle: `${targetRef} · conf ${selection.confidence.toFixed(2)}`,
    body: {
      kind: "target_resolution",
      targetRef,
      confidence: selection.confidence,
    },
  };
  const planChip: ToolChip = {
    chipId: makeId("chip"),
    verb: "create_plan",
    status: "done",
    icon: "check",
    title: "Create edit plan",
    subtitle: `${plan.planId} · ${slideId} · ${plan.operations.length} ops`,
    body: operationSummaries.length
      ? {
          kind: "operation_list",
          operations: operationSummaries,
        }
      : undefined,
  };
  const applyChip: ToolChip = {
    chipId: decision.decisionId,
    verb: "apply_plan",
    status: "awaiting_input",
    icon: "edit",
    purpose: "confirm_risk",
    sourceVersionId: versionId,
    subjectVersionId: versionId,
    title: `Apply edit plan to ${versionId}`,
    subtitle: `${plan.planId} · ${slideId} · ${plan.operations.length} ops`,
    body: operationSummaries.length
      ? {
          kind: "operation_list",
          operations: operationSummaries,
        }
      : undefined,
    input: {
      mode: "yes_no",
      primary: { id: "apply", label: "Apply edit" },
      secondary: { id: "reject", label: "Reject" },
    },
  };
  return [
    { type: "user_message", itemId: makeId("user"), text: message },
    reasoningEvent("Checking the selected slide."),
    reasoningEvent("Selecting from the allowed operation menu."),
    reasoningEvent("Preparing a preview."),
    reasoningEvent("Checking that the plan stays in scope."),
    { type: "prose_start", itemId: proseId },
    {
      type: "prose_chunk",
      itemId: proseId,
      delta: "I selected an allowed operation and prepared a version-bound preview.",
    },
    { type: "prose_end", itemId: proseId },
    { type: "tool_start", chip: resolveChip },
    { type: "tool_start", chip: planChip },
    { type: "tool_start", chip: applyChip },
    { type: "banner", tone: "info", text: "Approval required before any deck mutation" },
  ];
}

function createClarificationEvents(
  message: string,
  decision: StoredDecision,
  selection: OperationSelection,
): AgentEvent[] {
  const proseId = makeId("prose");
  const chip: ToolChip = {
    chipId: decision.decisionId,
    verb: "resolve_target",
    status: "awaiting_input",
    icon: "warning",
    purpose: "choose_target",
    sourceVersionId: decision.versionId,
    subjectVersionId: decision.versionId,
    title: decision.title,
    subtitle: selection.reason,
    input: decision.options?.length
      ? {
          mode: "single_choice",
          options: decision.options,
        }
      : {
          mode: "free_text",
          placeholder: "Describe which object to edit",
        },
  };
  return [
    { type: "user_message", itemId: makeId("user"), text: message },
    reasoningEvent("Checking the selected slide."),
    reasoningEvent("Selecting from the allowed operation menu.", "failed"),
    { type: "prose_start", itemId: proseId },
    {
      type: "prose_chunk",
      itemId: proseId,
      delta: "I need to resolve the exact edit target before preparing a preview.",
    },
    { type: "prose_end", itemId: proseId },
    { type: "tool_start", chip },
  ];
}

function clarifyTargetResolvedEvents(decisionId: string): AgentEvent[] {
  return [
    {
      type: "tool_complete",
      chipId: decisionId,
      patch: {
        status: "done",
        icon: "check",
        input: undefined,
        subtitle: "target clarification captured",
      },
    },
  ];
}

function applyCompleteEvents(
  applyDecisionId: string,
  sourceVersionId: string,
  outputVersionId: string,
  changedSlides: string[],
  warnings: number,
): AgentEvent[] {
  const editChip: ToolChip = {
    chipId: makeId("chip"),
    verb: "apply_plan",
    status: "done",
    icon: "check",
    title: `Patch ${sourceVersionId} -> ${outputVersionId}`,
    subtitle: `${changedSlides.length} changed slide(s)`,
  };
  const renderChip: ToolChip = {
    chipId: makeId("chip"),
    verb: "render",
    status: "done",
    icon: "check",
    title: `Render ${outputVersionId}`,
    subtitle: changedSlides.join(" · "),
    body: { kind: "render_summary", affectedSlides: changedSlides },
  };
  const validateChip: ToolChip = {
    chipId: makeId("chip"),
    verb: "validate",
    status: "done",
    icon: "check",
    title: `Validate ${outputVersionId}`,
    subtitle: `${changedSlides.length} changed · 0 blocking · ${warnings} warnings`,
  };
  return [
    {
      type: "tool_complete",
      chipId: applyDecisionId,
      patch: { status: "done", icon: "check", input: undefined, subtitle: "approved" },
    },
    reasoningEvent("Applying the approved edit."),
    reasoningEvent("Rendering the updated slide."),
    reasoningEvent("Validating the changed slide."),
    { type: "tool_start", chip: editChip },
    { type: "tool_start", chip: renderChip },
    { type: "tool_start", chip: validateChip },
    { type: "banner", tone: "info", text: "Applied · draft version active · export available" },
  ];
}

function truncateText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}

function reasoningEvent(
  text: string,
  status: "running" | "done" | "failed" = "done",
): AgentEvent {
  return {
    type: "reasoning",
    itemId: makeId("reasoning"),
    status,
    text: truncateReasoningText(text),
  };
}

function truncateReasoningText(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  const words = clean.split(" ").filter(Boolean);
  if (words.length <= 60) return clean;
  return `${words.slice(0, 60).join(" ")}...`;
}

function acceptVersionEvents(decisionId: string, versionId: string): AgentEvent[] {
  return [
    {
      type: "tool_complete",
      chipId: decisionId,
      patch: { status: "done", icon: "check", input: undefined, subtitle: `${versionId} accepted` },
    },
    { type: "banner", tone: "info", text: `${versionId} accepted · original preserved · export available` },
  ];
}

function rejectPlanEvents(decisionId: string): AgentEvent[] {
  return [
    {
      type: "tool_failed",
      chipId: decisionId,
      failure: {
        code: "USER_REJECTED",
        message: "Plan rejected. Refine the prompt and try again.",
        recovery: [],
      },
    },
  ];
}

function rejectVersionEvents(decisionId: string): AgentEvent[] {
  return [
    {
      type: "tool_failed",
      chipId: decisionId,
      failure: {
        code: "USER_REJECTED",
        message: "Version rejected. Restored to the previous working version.",
        recovery: [],
      },
    },
  ];
}

function refineVersionEvents(decisionId: string): AgentEvent[] {
  return [
    {
      type: "tool_complete",
      chipId: decisionId,
      patch: {
        status: "done",
        icon: "edit",
        input: undefined,
        subtitle: "ready for refinement",
      },
    },
    { type: "banner", tone: "info", text: "Edit kept active · refine with another prompt" },
  ];
}
