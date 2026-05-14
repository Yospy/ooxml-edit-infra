export type UiState =
  | "upload_empty"
  | "uploading"
  | "processing"
  | "ready"
  | "planning"
  | "awaiting_plan_approval"
  | "editing"
  | "validating"
  | "review_ready"
  | "accepted";

export type SlideStatus = "ready" | "changed" | "warning" | "failed" | "rendering";

export type ValidationSummary = {
  blockingCount: number;
  warningCount: number;
  canAccept: boolean;
  canExport: boolean;
  warnings: string[];
};

export type Slide = {
  slideId: string;
  number: number;
  title: string;
  subtitle: string;
  status: SlideStatus;
  thumbnailUrl?: string;
  renderUrl?: string;
};

export type VersionNode = {
  id: string;
  label: string;
  parentId: string | null;
  status: "original" | "working" | "edited" | "accepted" | "rejected";
};

export type DeckStatus = {
  deckId: string;
  fileName: string;
  activeVersionId: string;
  parentVersionId: string | null;
  originalVersionId: string;
  changedSlides: string[];
  slideStatuses: Record<string, SlideStatus>;
  validationSummary: ValidationSummary;
  slides: Slide[];
  versions: VersionNode[];
};

export type ProcessingProgress = {
  upload: number;
  parse: number;
  render: number;
  validate: number;
};

export type DecisionOption = {
  id: string;
  label: string;
  description?: string;
};

export type DecisionPurpose =
  | "clarify_intent"
  | "choose_target"
  | "confirm_risk"
  | "final_edit_review";

export type ToolVerb =
  | "resolve_target"
  | "create_plan"
  | "apply_plan"
  | "render"
  | "validate"
  | "request_repair"
  | "accept_version"
  | "export";

export type ToolStatus =
  | "running"
  | "awaiting_input"
  | "submitting"
  | "done"
  | "failed";

export type ToolIcon =
  | "arrow"
  | "edit"
  | "gear"
  | "image"
  | "check"
  | "download"
  | "warning";

export type ToolChipBody =
  | { kind: "text_diff"; before: string; after: string; flags: string[] }
  | { kind: "operation_list"; operations: OperationPreviewSummary[] }
  | {
      kind: "validation";
      changed: number;
      blocking: number;
      warnings: number;
      warningText?: string;
    }
  | { kind: "render_summary"; affectedSlides: string[] }
  | { kind: "target_resolution"; targetRef: string; confidence: number };

export type ChipInput =
  | { mode: "yes_no"; primary: DecisionOption; secondary: DecisionOption }
  | { mode: "single_choice"; options: DecisionOption[] }
  | { mode: "free_text"; placeholder: string };

export type ChipFailure = {
  code: string;
  message: string;
  recovery: DecisionOption[];
};

export type ToolChip = {
  chipId: string;
  verb: ToolVerb;
  status: ToolStatus;
  icon: ToolIcon;
  purpose?: DecisionPurpose;
  sourceVersionId?: string;
  subjectVersionId?: string;
  title: string;
  subtitle?: string;
  body?: ToolChipBody;
  input?: ChipInput;
  failure?: ChipFailure;
  jobId?: string;
};

export type AgentEvent =
  | { type: "user_message"; itemId: string; text: string }
  | {
      type: "reasoning";
      itemId: string;
      status: "running" | "done" | "failed";
      text: string;
    }
  | { type: "prose_start"; itemId: string }
  | { type: "prose_chunk"; itemId: string; delta: string }
  | { type: "prose_end"; itemId: string }
  | { type: "tool_start"; chip: ToolChip }
  | { type: "tool_update"; chipId: string; patch: Partial<ToolChip> }
  | { type: "tool_complete"; chipId: string; patch: Partial<ToolChip> }
  | { type: "tool_failed"; chipId: string; failure: ChipFailure }
  | { type: "decision_required"; chipId: string; input: ChipInput }
  | {
      type: "decision_resolved";
      chipId: string;
      selectedId?: string;
      answerText?: string;
    }
  | { type: "banner"; tone: "info" | "warn"; text: string };

export type EditOperation = {
  operationId: string;
  operationType: "replace_text" | "fit_text" | "set_slide_background";
  targetRef: string;
  humanLabel: string;
  before: string;
  after: string;
  preserveStyle: boolean;
  preserveBounds?: boolean;
  args?: Record<string, string | number | boolean | null>;
  preview?: OperationPreviewSummary;
};

export type OperationPreviewSummary = {
  operationType: EditOperation["operationType"];
  targetRef: string;
  label: string;
  kind: "text" | "property";
  property?: string;
  before: string;
  after: string;
};

export type EditPlan = {
  planId: string;
  planType: "edit" | "repair";
  deckId: string;
  createdFromVersionId: string;
  status: "awaiting_approval" | "approved" | "applied" | "rejected";
  summary: string;
  affectedSlides: string[];
  operations: EditOperation[];
  risks: string[];
  requiresApproval: true;
};

export type DecisionRequest = {
  decisionId: string;
  deckId: string;
  versionId: string;
  planId?: string;
  purpose: DecisionPurpose;
  sourceVersionId?: string;
  subjectVersionId?: string;
  kind:
    | "clarification"
    | "approval"
    | "risk_confirmation"
    | "repair_approval"
    | "export_confirmation";
  title: string;
  question: string;
  context?: string;
  inputMode: "yes_no" | "single_choice" | "free_text";
  options?: DecisionOption[];
  defaultOptionId?: string;
  required: true;
  blocksWorkflow: true;
};

export type DecisionResponse = {
  versionId: string;
  selectedOptionId?: string;
  answerText?: string;
};

export type ReviewResult = {
  inputVersionId: string;
  outputVersionId: string;
  activeVersionId: string;
  parentVersionId: string;
  originalVersionId: string;
  changedSlides: string[];
  slideStatuses: Record<string, SlideStatus>;
  validationSummary: ValidationSummary;
  slidePreviews: Array<{
    slideId: string;
    before: {
      versionId: string;
      title: string;
      subtitle: string;
      renderUrl?: string;
    };
    after: {
      versionId: string;
      title: string;
      subtitle: string;
      renderUrl?: string;
    };
  }>;
};

export type ProposalPreview = {
  planId: string;
  decisionId: string;
  slideId: string;
  versionId: string;
  renderUrl?: string;
  targetRefs: string[];
  operations: EditOperation[];
};

export type ThreadSummary = {
  threadId: string;
  deckId: string;
  title: string;
  status: "active" | "archived";
  messageCount: number;
  createdAt: string;
  updatedAt: string;
};

export type ExportArtifact = {
  deckId: string;
  versionId: string;
  fileName: string;
  downloadUrl: string;
  status: "prepared";
};

export type JobStatus = {
  jobId: string;
  deckId?: string;
  versionId?: string;
  jobType:
    | "upload_process"
    | "parse"
    | "render"
    | "request_edit_plan"
    | "apply_plan"
    | "validate"
    | "request_repair_plan"
    | "export";
  status: "queued" | "running" | "succeeded" | "failed";
  progress: ProcessingProgress;
  result?: unknown;
  errorMessage?: string;
};

export type RequestEditInput = {
  deckId: string;
  versionId: string;
  threadId?: string;
  message: string;
  selectedSlideId?: string;
  selectedSlideContext?: {
    slideId: string;
    number: number;
    title: string;
    subtitle: string;
    activeVersionId: string;
  };
  selectedElementIds?: string[];
  visibleSlideIds?: string[];
  uiMode?: UiState;
  clientContext?: Record<string, unknown>;
};
