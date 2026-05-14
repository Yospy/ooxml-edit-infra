import type {
  DecisionOption,
  DecisionRequest,
  DecisionPurpose,
  DeckStatus,
  EditOperation,
  EditPlan,
  ExportArtifact,
  JobStatus,
  ProcessingProgress,
  Slide,
  SlideStatus,
  ThreadSummary,
  ValidationSummary,
  VersionNode,
} from "./types.js";
import type { AppDatabase } from "./database.js";
import { DEFAULT_PROJECT_ID, DEFAULT_THREAD_TITLE, makeId } from "./ids.js";

export type PresentationRow = {
  id: string;
  projectId: string;
  fileName: string;
  originalVersionId: string;
  activeVersionId: string;
  status: string;
  createdAt: string;
  updatedAt: string;
};

export type VersionRow = {
  uid: string;
  presentationId: string;
  versionId: string;
  parentVersionId: string | null;
  versionNumber: number;
  status: VersionNode["status"];
  filePath: string;
  extractedPath: string;
  graphPath: string;
  createdByPlanId: string | null;
  createdAt: string;
};

export type ArtifactRow = {
  id: string;
  presentationId: string;
  versionId: string | null;
  type: string;
  path: string;
  contentType: string;
  slideId: string | null;
  createdAt: string;
};

export type SlideElementRecord = {
  slideId: string;
  elementId: string;
  elementType: string;
  role: string;
  text: string;
  bounds: BoundsEmu;
  style: Record<string, unknown>;
  xmlProvenance: XmlProvenance;
};

export type BoundsEmu = {
  x: number;
  y: number;
  w: number;
  h: number;
};

export type XmlProvenance = {
  part: string;
  shapeId: string;
  shapeName: string;
};

export type GraphSlide = {
  slideId: string;
  number: number;
  title: string;
  subtitle: string;
  widthEmu: number;
  heightEmu: number;
  elements: SlideElementRecord[];
};

export type CanonicalGraph = {
  presentationId: string;
  versionId: string;
  slides: GraphSlide[];
};

export type StoredDecision = DecisionRequest & {
  action: "apply_plan" | "accept_version";
  status: "awaiting" | "answered" | "expired";
  threadId?: string;
};

export type StoredJob = JobStatus & {
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
};

export type StoredPlan = EditPlan & {
  threadId: string;
  userPrompt: string;
};

export type ThreadRow = {
  id: string;
  presentationId: string;
  title: string;
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
  messageCount: number;
};

export type ValidationIssue = {
  id: string;
  presentationId: string;
  versionId: string;
  slideId: string | null;
  issueType: string;
  severity: "blocking" | "warning" | "info";
  message: string;
  targetRef: string | null;
  details: Record<string, unknown>;
};

export class SQLiteRepository {
  constructor(private readonly db: AppDatabase) {
    this.ensureDefaultProject();
  }

  close(): void {
    this.db.close();
  }

  ensureDefaultProject(): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO projects (id, name, created_at)
         VALUES (?, ?, ?)`,
      )
      .run(DEFAULT_PROJECT_ID, "Local Project", now());
  }

  createPresentation(input: {
    id: string;
    fileName: string;
    originalVersionId: string;
    activeVersionId: string;
  }): PresentationRow {
    const timestamp = now();
    this.db
      .prepare(
        `INSERT INTO presentations
          (id, project_id, file_name, original_version_id, active_version_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        DEFAULT_PROJECT_ID,
        input.fileName,
        input.originalVersionId,
        input.activeVersionId,
        "ready",
        timestamp,
        timestamp,
      );
    return this.requirePresentation(input.id);
  }

  requirePresentation(id: string): PresentationRow {
    const row = this.db
      .prepare(`SELECT * FROM presentations WHERE id = ?`)
      .get(id) as DbPresentation | undefined;
    if (!row) throw new Error(`Presentation not found: ${id}`);
    return mapPresentation(row);
  }

  getPresentation(id: string): PresentationRow | undefined {
    const row = this.db
      .prepare(`SELECT * FROM presentations WHERE id = ?`)
      .get(id) as DbPresentation | undefined;
    return row ? mapPresentation(row) : undefined;
  }

  getLatestPresentation(): PresentationRow | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM presentations
         ORDER BY updated_at DESC, created_at DESC
         LIMIT 1`,
      )
      .get() as DbPresentation | undefined;
    return row ? mapPresentation(row) : undefined;
  }

  updatePresentationActiveVersion(
    presentationId: string,
    versionId: string,
    status = "ready",
  ): void {
    this.db
      .prepare(
        `UPDATE presentations
         SET active_version_id = ?, status = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(versionId, status, now(), presentationId);
  }

  saveVersion(input: Omit<VersionRow, "uid" | "createdAt"> & { createdAt?: string }): VersionRow {
    const row: VersionRow = {
      ...input,
      uid: `${input.presentationId}:${input.versionId}`,
      createdAt: input.createdAt ?? now(),
    };
    this.db
      .prepare(
        `INSERT OR REPLACE INTO presentation_versions
          (uid, presentation_id, version_id, parent_version_id, version_number, status,
           file_path, extracted_path, graph_path, created_by_plan_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.uid,
        row.presentationId,
        row.versionId,
        row.parentVersionId,
        row.versionNumber,
        row.status,
        row.filePath,
        row.extractedPath,
        row.graphPath,
        row.createdByPlanId,
        row.createdAt,
      );
    return row;
  }

  getVersion(presentationId: string, versionId: string): VersionRow | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM presentation_versions
         WHERE presentation_id = ? AND version_id = ?`,
      )
      .get(presentationId, versionId) as DbVersion | undefined;
    return row ? mapVersion(row) : undefined;
  }

  requireVersion(presentationId: string, versionId: string): VersionRow {
    const version = this.getVersion(presentationId, versionId);
    if (!version) throw new Error(`Version not found: ${presentationId}/${versionId}`);
    return version;
  }

  listVersions(presentationId: string): VersionRow[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM presentation_versions
           WHERE presentation_id = ?
           ORDER BY version_number ASC, created_at ASC`,
        )
        .all(presentationId) as DbVersion[]
    ).map(mapVersion);
  }

  markVersionStatus(
    presentationId: string,
    versionId: string,
    status: VersionNode["status"],
  ): void {
    this.db
      .prepare(
        `UPDATE presentation_versions
         SET status = ?
         WHERE presentation_id = ? AND version_id = ?`,
      )
      .run(status, presentationId, versionId);
  }

  nextVersionId(presentationId: string): string {
    const row = this.db
      .prepare(
        `SELECT MAX(version_number) AS max_version
         FROM presentation_versions
         WHERE presentation_id = ? AND version_id != 'original'`,
      )
      .get(presentationId) as { max_version?: number | null };
    return `v${Number(row.max_version ?? 0) + 1}`;
  }

  createThread(presentationId: string, title = DEFAULT_THREAD_TITLE): ThreadSummary {
    this.requirePresentation(presentationId);
    const threadId = makeId("thread");
    const timestamp = now();
    this.db
      .prepare(
        `INSERT INTO threads
          (id, presentation_id, title, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(threadId, presentationId, title, "active", timestamp, timestamp);
    return toThreadSummary({
      id: threadId,
      presentationId,
      title,
      status: "active",
      createdAt: timestamp,
      updatedAt: timestamp,
      messageCount: 0,
    });
  }

  listThreads(presentationId: string): ThreadSummary[] {
    this.requirePresentation(presentationId);
    return (
      this.db
        .prepare(
          `SELECT t.*,
                  COUNT(m.id) AS message_count
           FROM threads t
           LEFT JOIN thread_messages m ON m.thread_id = t.id
           WHERE t.presentation_id = ?
           GROUP BY t.id
           ORDER BY t.updated_at DESC, t.created_at DESC`,
        )
        .all(presentationId) as DbThread[]
    ).map(mapThread).map(toThreadSummary);
  }

  getThread(threadId: string): ThreadRow | undefined {
    const row = this.db
      .prepare(
        `SELECT t.*,
                COUNT(m.id) AS message_count
         FROM threads t
         LEFT JOIN thread_messages m ON m.thread_id = t.id
         WHERE t.id = ?
         GROUP BY t.id`,
      )
      .get(threadId) as DbThread | undefined;
    return row ? mapThread(row) : undefined;
  }

  requireThreadForPresentation(presentationId: string, threadId: string): ThreadRow {
    const thread = this.getThread(threadId);
    if (!thread || thread.presentationId !== presentationId) {
      throw new Error(`Thread not found for presentation: ${presentationId}/${threadId}`);
    }
    return thread;
  }

  ensureThread(presentationId: string): string {
    const existing = this.db
      .prepare(
        `SELECT id FROM threads
         WHERE presentation_id = ? AND status = 'active'
         ORDER BY created_at ASC
         LIMIT 1`,
      )
      .get(presentationId) as { id: string } | undefined;
    if (existing) return existing.id;

    return this.createThread(presentationId).threadId;
  }

  saveThreadMessage(threadId: string, role: "user" | "assistant", content: string): void {
    const timestamp = now();
    this.db
      .prepare(
        `INSERT INTO thread_messages (id, thread_id, role, content, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(makeId("msg"), threadId, role, content, timestamp);
    this.db
      .prepare(
        `UPDATE threads
         SET updated_at = ?
         WHERE id = ?`,
      )
      .run(timestamp, threadId);
  }

  replaceSlidesAndElements(graph: CanonicalGraph): void {
    this.db
      .prepare(`DELETE FROM slide_elements WHERE presentation_id = ? AND version_id = ?`)
      .run(graph.presentationId, graph.versionId);
    this.db
      .prepare(`DELETE FROM slides WHERE presentation_id = ? AND version_id = ?`)
      .run(graph.presentationId, graph.versionId);

    for (const slide of graph.slides) {
      this.db
        .prepare(
          `INSERT INTO slides
            (uid, presentation_id, version_id, slide_index, slide_id, title, subtitle, status,
             width_emu, height_emu, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          `${graph.presentationId}:${graph.versionId}:${slide.slideId}`,
          graph.presentationId,
          graph.versionId,
          slide.number,
          slide.slideId,
          slide.title,
          slide.subtitle,
          "ready",
          slide.widthEmu,
          slide.heightEmu,
          now(),
        );
      for (const element of slide.elements) {
        this.db
          .prepare(
            `INSERT INTO slide_elements
              (uid, presentation_id, version_id, slide_id, element_id, element_type, role,
               text, bounds_json, style_json, xml_provenance_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            `${graph.presentationId}:${graph.versionId}:${slide.slideId}:${element.elementId}`,
            graph.presentationId,
            graph.versionId,
            slide.slideId,
            element.elementId,
            element.elementType,
            element.role,
            element.text,
            toJson(element.bounds),
            toJson(element.style),
            toJson(element.xmlProvenance),
            now(),
          );
      }
    }
  }

  listSlides(presentationId: string, versionId: string): Slide[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM slides
           WHERE presentation_id = ? AND version_id = ?
           ORDER BY slide_index ASC`,
        )
        .all(presentationId, versionId) as DbSlide[]
    ).map((row) => ({
      slideId: row.slide_id,
      number: row.slide_index,
      title: row.title,
      subtitle: row.subtitle,
      status: row.status as SlideStatus,
    }));
  }

  markSlideStatus(
    presentationId: string,
    versionId: string,
    slideId: string,
    status: SlideStatus,
  ): void {
    this.db
      .prepare(
        `UPDATE slides
         SET status = ?
         WHERE presentation_id = ? AND version_id = ? AND slide_id = ?`,
      )
      .run(status, presentationId, versionId, slideId);
  }

  listElements(
    presentationId: string,
    versionId: string,
    slideId?: string,
  ): SlideElementRecord[] {
    const rows = slideId
      ? (this.db
          .prepare(
            `SELECT * FROM slide_elements
             WHERE presentation_id = ? AND version_id = ? AND slide_id = ?
             ORDER BY element_id ASC`,
          )
          .all(presentationId, versionId, slideId) as DbElement[])
      : (this.db
          .prepare(
            `SELECT * FROM slide_elements
             WHERE presentation_id = ? AND version_id = ?
             ORDER BY slide_id ASC, element_id ASC`,
          )
          .all(presentationId, versionId) as DbElement[]);
    return rows.map(mapElement);
  }

  getElementByTargetRef(
    presentationId: string,
    versionId: string,
    targetRef: string,
  ): SlideElementRecord | undefined {
    const [slideId, elementId] = targetRef.split(".");
    if (!slideId || !elementId) return undefined;
    const row = this.db
      .prepare(
        `SELECT * FROM slide_elements
         WHERE presentation_id = ? AND version_id = ? AND slide_id = ? AND element_id = ?`,
      )
      .get(presentationId, versionId, slideId, elementId) as DbElement | undefined;
    return row ? mapElement(row) : undefined;
  }

  saveArtifact(input: Omit<ArtifactRow, "id" | "createdAt"> & { id?: string }): ArtifactRow {
    const row: ArtifactRow = {
      ...input,
      id: input.id ?? makeId("artifact"),
      createdAt: now(),
    };
    this.db
      .prepare(
        `INSERT OR REPLACE INTO artifacts
          (id, presentation_id, version_id, type, path, content_type, slide_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.presentationId,
        row.versionId,
        row.type,
        row.path,
        row.contentType,
        row.slideId,
        row.createdAt,
      );
    return row;
  }

  getArtifact(id: string): ArtifactRow | undefined {
    const row = this.db
      .prepare(`SELECT * FROM artifacts WHERE id = ?`)
      .get(id) as DbArtifact | undefined;
    return row ? mapArtifact(row) : undefined;
  }

  findArtifact(input: {
    presentationId: string;
    versionId?: string;
    type: string;
    slideId?: string;
  }): ArtifactRow | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM artifacts
         WHERE presentation_id = ?
           AND COALESCE(version_id, '') = COALESCE(?, '')
           AND type = ?
           AND COALESCE(slide_id, '') = COALESCE(?, '')
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(
        input.presentationId,
        input.versionId ?? null,
        input.type,
        input.slideId ?? null,
      ) as DbArtifact | undefined;
    return row ? mapArtifact(row) : undefined;
  }

  saveJob(job: StoredJob): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO jobs
          (id, presentation_id, version_id, job_type, status, progress_json, result_json,
           error_message, created_at, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        job.jobId,
        job.deckId ?? null,
        job.versionId ?? null,
        job.jobType,
        job.status,
        toJson(job.progress),
        job.result === undefined ? null : toJson(job.result),
        job.errorMessage ?? null,
        job.createdAt,
        job.startedAt ?? null,
        job.finishedAt ?? null,
      );
  }

  getJob(jobId: string): StoredJob | undefined {
    const row = this.db
      .prepare(`SELECT * FROM jobs WHERE id = ?`)
      .get(jobId) as DbJob | undefined;
    return row ? mapJob(row) : undefined;
  }

  savePlan(plan: StoredPlan): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO edit_plans
          (id, presentation_id, thread_id, created_from_version_id, plan_type, status,
           user_prompt, summary, risks_json, affected_slides_json, created_at, approved_at, applied_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT created_at FROM edit_plans WHERE id = ?), ?), ?, ?)`,
      )
      .run(
        plan.planId,
        plan.deckId,
        plan.threadId,
        plan.createdFromVersionId,
        plan.planType,
        plan.status,
        plan.userPrompt,
        plan.summary,
        toJson(plan.risks),
        toJson(plan.affectedSlides),
        plan.planId,
        now(),
        plan.status === "approved" ? now() : null,
        plan.status === "applied" ? now() : null,
      );

    this.db.prepare(`DELETE FROM edit_operations WHERE plan_id = ?`).run(plan.planId);
    for (const op of plan.operations) {
      this.saveOperation(plan.deckId, plan.planId, op, plan.status === "applied" ? "applied" : "planned");
    }
  }

  getPlan(planId: string): StoredPlan | undefined {
    const row = this.db
      .prepare(`SELECT * FROM edit_plans WHERE id = ?`)
      .get(planId) as DbPlan | undefined;
    if (!row) return undefined;
    const operations = (
      this.db
        .prepare(`SELECT * FROM edit_operations WHERE plan_id = ? ORDER BY id ASC`)
        .all(planId) as DbOperation[]
    ).map(mapOperation);
    return mapPlan(row, operations);
  }

  updatePlanStatus(planId: string, status: EditPlan["status"]): void {
    const approvedAt = status === "approved" ? now() : null;
    const appliedAt = status === "applied" ? now() : null;
    this.db
      .prepare(
        `UPDATE edit_plans
         SET status = ?,
             approved_at = COALESCE(approved_at, ?),
             applied_at = COALESCE(applied_at, ?)
         WHERE id = ?`,
      )
      .run(status, approvedAt, appliedAt, planId);
    this.db
      .prepare(`UPDATE edit_operations SET status = ? WHERE plan_id = ?`)
      .run(status === "applied" ? "applied" : status, planId);
  }

  saveDecision(decision: StoredDecision): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO decisions
          (id, presentation_id, version_id, plan_id, thread_id, purpose, source_version_id,
           subject_version_id, kind, action, status,
           title, question, context, input_mode, options_json, default_option_id,
           answer_json, created_at, answered_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
           COALESCE((SELECT created_at FROM decisions WHERE id = ?), ?), ?)`,
      )
      .run(
        decision.decisionId,
        decision.deckId,
        decision.versionId,
        decision.planId ?? null,
        decision.threadId ?? null,
        decision.purpose,
        decision.sourceVersionId ?? null,
        decision.subjectVersionId ?? null,
        decision.kind,
        decision.action,
        decision.status,
        decision.title,
        decision.question,
        decision.context ?? null,
        decision.inputMode,
        toJson(decision.options ?? []),
        decision.defaultOptionId ?? null,
        decision.status === "answered" ? toJson({ answered: true }) : null,
        decision.decisionId,
        now(),
        decision.status === "answered" ? now() : null,
      );
  }

  getDecision(decisionId: string): StoredDecision | undefined {
    const row = this.db
      .prepare(`SELECT * FROM decisions WHERE id = ?`)
      .get(decisionId) as DbDecision | undefined;
    return row ? mapDecision(row) : undefined;
  }

  addValidationIssue(issue: Omit<ValidationIssue, "id">): ValidationIssue {
    const saved: ValidationIssue = { ...issue, id: makeId("issue") };
    this.db
      .prepare(
        `INSERT INTO validation_results
          (id, presentation_id, version_id, slide_id, issue_type, severity, message, target_ref, details_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        saved.id,
        saved.presentationId,
        saved.versionId,
        saved.slideId,
        saved.issueType,
        saved.severity,
        saved.message,
        saved.targetRef,
        toJson(saved.details),
        now(),
      );
    return saved;
  }

  clearValidation(presentationId: string, versionId: string): void {
    this.db
      .prepare(`DELETE FROM validation_results WHERE presentation_id = ? AND version_id = ?`)
      .run(presentationId, versionId);
  }

  validationSummary(presentationId: string, versionId: string): ValidationSummary {
    const rows = this.db
      .prepare(
        `SELECT * FROM validation_results
         WHERE presentation_id = ? AND version_id = ?`,
      )
      .all(presentationId, versionId) as DbValidation[];
    const blocking = rows.filter((row) => row.severity === "blocking");
    const warnings = rows.filter((row) => row.severity === "warning");
    const editedOrAccepted = this.getVersion(presentationId, versionId)?.status;
    return {
      blockingCount: blocking.length,
      warningCount: warnings.length,
      canAccept:
        blocking.length === 0 &&
        (editedOrAccepted === "edited" || editedOrAccepted === "accepted"),
      canExport:
        blocking.length === 0 &&
        (editedOrAccepted === "edited" || editedOrAccepted === "accepted"),
      warnings: warnings.map((row) => row.message),
    };
  }

  saveExport(input: {
    presentationId: string;
    versionId: string;
    filePath: string;
    artifactId: string;
  }): ExportArtifact {
    const id = makeId("export");
    this.db
      .prepare(
        `INSERT INTO exports
          (id, presentation_id, version_id, file_path, artifact_id, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.presentationId, input.versionId, input.filePath, input.artifactId, "prepared", now());
    const presentation = this.requirePresentation(input.presentationId);
    return {
      deckId: input.presentationId,
      versionId: input.versionId,
      fileName: `${presentation.fileName.replace(/\.pptx$/i, "")}-${input.versionId}.pptx`,
      downloadUrl: `/api/artifacts/${input.artifactId}`,
      status: "prepared",
    };
  }

  deckStatus(presentationId: string): DeckStatus {
    const presentation = this.requirePresentation(presentationId);
    const slides = this.listSlides(presentationId, presentation.activeVersionId).map((slide) => {
      const render = this.findArtifact({
        presentationId,
        versionId: presentation.activeVersionId,
        type: "slide_render",
        slideId: slide.slideId,
      });
      const thumb = this.findArtifact({
        presentationId,
        versionId: presentation.activeVersionId,
        type: "slide_thumbnail",
        slideId: slide.slideId,
      });
      return {
        ...slide,
        renderUrl: render ? `/api/artifacts/${render.id}` : undefined,
        thumbnailUrl: thumb ? `/api/artifacts/${thumb.id}` : undefined,
      };
    });
    const versions = this.listVersions(presentationId).map(toVersionNode);
    const slideStatuses = Object.fromEntries(
      slides.map((slide) => [slide.slideId, slide.status]),
    ) as Record<string, SlideStatus>;
    return {
      deckId: presentation.id,
      fileName: presentation.fileName,
      activeVersionId: presentation.activeVersionId,
      parentVersionId:
        this.getVersion(presentationId, presentation.activeVersionId)?.parentVersionId ?? null,
      originalVersionId: presentation.originalVersionId,
      changedSlides: slides
        .filter((slide) => slide.status === "changed" || slide.status === "warning")
        .map((slide) => slide.slideId),
      slideStatuses,
      validationSummary: this.validationSummary(presentationId, presentation.activeVersionId),
      slides,
      versions,
    };
  }

  private saveOperation(
    presentationId: string,
    planId: string,
    op: EditOperation,
    status: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO edit_operations
          (id, plan_id, presentation_id, operation_type, target_ref, human_label, payload_json,
           before_json, after_json, preserve_style, preserve_bounds, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        op.operationId,
        planId,
        presentationId,
        op.operationType,
        op.targetRef,
        op.humanLabel,
        toJson({ operationType: op.operationType }),
        toJson(op.before),
        toJson(op.after),
        op.preserveStyle ? 1 : 0,
        op.preserveBounds ? 1 : 0,
        status,
        now(),
      );
  }
}

function now(): string {
  return new Date().toISOString();
}

function toJson(value: unknown): string {
  return JSON.stringify(value);
}

function fromJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  return JSON.parse(value) as T;
}

function toVersionNode(row: VersionRow): VersionNode {
  return {
    id: row.versionId,
    label:
      row.versionId === "original"
        ? "Original"
        : `${row.versionId} ${row.status}`,
    parentId: row.parentVersionId,
    status: row.status,
  };
}

function mapPresentation(row: DbPresentation): PresentationRow {
  return {
    id: row.id,
    projectId: row.project_id,
    fileName: row.file_name,
    originalVersionId: row.original_version_id,
    activeVersionId: row.active_version_id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapThread(row: DbThread): ThreadRow {
  return {
    id: row.id,
    presentationId: row.presentation_id,
    title: row.title,
    status: row.status as ThreadRow["status"],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messageCount: Number(row.message_count ?? 0),
  };
}

function toThreadSummary(row: ThreadRow): ThreadSummary {
  return {
    threadId: row.id,
    deckId: row.presentationId,
    title: row.title,
    status: row.status,
    messageCount: row.messageCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapVersion(row: DbVersion): VersionRow {
  return {
    uid: row.uid,
    presentationId: row.presentation_id,
    versionId: row.version_id,
    parentVersionId: row.parent_version_id,
    versionNumber: row.version_number,
    status: row.status as VersionNode["status"],
    filePath: row.file_path,
    extractedPath: row.extracted_path,
    graphPath: row.graph_path,
    createdByPlanId: row.created_by_plan_id,
    createdAt: row.created_at,
  };
}

function mapArtifact(row: DbArtifact): ArtifactRow {
  return {
    id: row.id,
    presentationId: row.presentation_id,
    versionId: row.version_id,
    type: row.type,
    path: row.path,
    contentType: row.content_type,
    slideId: row.slide_id,
    createdAt: row.created_at,
  };
}

function mapJob(row: DbJob): StoredJob {
  return {
    jobId: row.id,
    deckId: row.presentation_id ?? undefined,
    versionId: row.version_id ?? undefined,
    jobType: row.job_type as JobStatus["jobType"],
    status: row.status as JobStatus["status"],
    progress: fromJson<ProcessingProgress>(row.progress_json, {
      upload: 0,
      parse: 0,
      render: 0,
      validate: 0,
    }),
    result: fromJson<unknown | undefined>(row.result_json, undefined),
    errorMessage: row.error_message ?? undefined,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
  };
}

function mapElement(row: DbElement): SlideElementRecord {
  return {
    slideId: row.slide_id,
    elementId: row.element_id,
    elementType: row.element_type,
    role: row.role,
    text: row.text,
    bounds: fromJson<BoundsEmu>(row.bounds_json, { x: 0, y: 0, w: 0, h: 0 }),
    style: fromJson<Record<string, unknown>>(row.style_json, {}),
    xmlProvenance: fromJson<XmlProvenance>(row.xml_provenance_json, {
      part: "",
      shapeId: "",
      shapeName: "",
    }),
  };
}

function mapOperation(row: DbOperation): EditOperation {
  return {
    operationId: row.id,
    operationType: row.operation_type as EditOperation["operationType"],
    targetRef: row.target_ref,
    humanLabel: row.human_label,
    before: fromJson<string>(row.before_json, ""),
    after: fromJson<string>(row.after_json, ""),
    preserveStyle: row.preserve_style === 1,
    preserveBounds: row.preserve_bounds === 1,
  };
}

function mapPlan(row: DbPlan, operations: EditOperation[]): StoredPlan {
  return {
    planId: row.id,
    planType: row.plan_type as EditPlan["planType"],
    deckId: row.presentation_id,
    threadId: row.thread_id,
    userPrompt: row.user_prompt,
    createdFromVersionId: row.created_from_version_id,
    status: row.status as EditPlan["status"],
    summary: row.summary,
    affectedSlides: fromJson<string[]>(row.affected_slides_json, []),
    operations,
    risks: fromJson<string[]>(row.risks_json, []),
    requiresApproval: true,
  };
}

function mapDecision(row: DbDecision): StoredDecision {
  return {
    decisionId: row.id,
    deckId: row.presentation_id,
    versionId: row.version_id,
    planId: row.plan_id ?? undefined,
    threadId: row.thread_id ?? undefined,
    purpose: row.purpose as DecisionPurpose,
    sourceVersionId: row.source_version_id ?? undefined,
    subjectVersionId: row.subject_version_id ?? undefined,
    kind: row.kind as DecisionRequest["kind"],
    action: row.action as StoredDecision["action"],
    status: row.status as StoredDecision["status"],
    title: row.title,
    question: row.question,
    context: row.context ?? undefined,
    inputMode: row.input_mode as DecisionRequest["inputMode"],
    options: fromJson<DecisionOption[]>(row.options_json, []),
    defaultOptionId: row.default_option_id ?? undefined,
    required: true,
    blocksWorkflow: true,
  };
}

type DbPresentation = {
  id: string;
  project_id: string;
  file_name: string;
  original_version_id: string;
  active_version_id: string;
  status: string;
  created_at: string;
  updated_at: string;
};

type DbVersion = {
  uid: string;
  presentation_id: string;
  version_id: string;
  parent_version_id: string | null;
  version_number: number;
  status: string;
  file_path: string;
  extracted_path: string;
  graph_path: string;
  created_by_plan_id: string | null;
  created_at: string;
};

type DbThread = {
  id: string;
  presentation_id: string;
  title: string;
  status: string;
  created_at: string;
  updated_at: string;
  message_count?: number;
};

type DbArtifact = {
  id: string;
  presentation_id: string;
  version_id: string | null;
  type: string;
  path: string;
  content_type: string;
  slide_id: string | null;
  created_at: string;
};

type DbSlide = {
  slide_id: string;
  slide_index: number;
  title: string;
  subtitle: string;
  status: string;
};

type DbElement = {
  slide_id: string;
  element_id: string;
  element_type: string;
  role: string;
  text: string;
  bounds_json: string;
  style_json: string;
  xml_provenance_json: string;
};

type DbJob = {
  id: string;
  presentation_id: string | null;
  version_id: string | null;
  job_type: string;
  status: string;
  progress_json: string;
  result_json: string | null;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

type DbPlan = {
  id: string;
  presentation_id: string;
  thread_id: string;
  created_from_version_id: string;
  plan_type: string;
  status: string;
  user_prompt: string;
  summary: string;
  risks_json: string;
  affected_slides_json: string;
};

type DbOperation = {
  id: string;
  operation_type: string;
  target_ref: string;
  human_label: string;
  before_json: string;
  after_json: string;
  preserve_style: number;
  preserve_bounds: number;
};

type DbDecision = {
  id: string;
  presentation_id: string;
  version_id: string;
  plan_id: string | null;
  thread_id: string | null;
  purpose: string;
  source_version_id: string | null;
  subject_version_id: string | null;
  kind: string;
  action: string;
  status: string;
  title: string;
  question: string;
  context: string | null;
  input_mode: string;
  options_json: string;
  default_option_id: string | null;
};

type DbValidation = {
  severity: string;
  message: string;
};
