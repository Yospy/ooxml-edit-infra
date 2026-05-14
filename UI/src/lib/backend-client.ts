import type {
  AgentEvent,
  DecisionRequest,
  DeckStatus,
  ExportArtifact,
  JobStatus,
  ProposalPreview,
  ProcessingProgress,
  RequestEditInput,
  ReviewResult,
  ThreadSummary,
  UiState,
} from "@/lib/deck-types";

const API_BASE_URL =
  process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const emptyProgress: ProcessingProgress = {
  upload: 0,
  parse: 0,
  render: 0,
  validate: 0,
};

export function backendAssetUrl(path?: string): string | undefined {
  if (!path) return undefined;
  if (/^https?:\/\//.test(path)) return path;
  return `${API_BASE_URL}${path}`;
}

export type UploadDeckResponse = {
  deckId: string;
  jobId: string;
  uiState: "processing";
};

export type EditRequestResponse = {
  uiState: "awaiting_plan_approval" | "ready";
  threadId: string;
  events: AgentEvent[];
  editPlan?: unknown;
  decisionRequest: DecisionRequest;
  proposalPreview?: ProposalPreview;
};

export type DecisionResponsePayload = {
  versionId: string;
  selectedOptionId?: string;
  answerText?: string;
};

export type DecisionResponseResult = {
  uiState: UiState;
  jobId?: string;
  events?: AgentEvent[];
  deckStatus?: DeckStatus;
  reviewResult?: ReviewResult;
  decisionRequest?: DecisionRequest;
};

export type ApplyJobResult = {
  reviewResult: ReviewResult;
  deckStatus: DeckStatus;
  events: AgentEvent[];
};

export type ExportVersionResponse = {
  uiState: UiState;
  exportArtifact: ExportArtifact;
  deckStatus: DeckStatus;
};

export type CurrentWorkspaceResponse = {
  deckStatus: DeckStatus | null;
};

export type ThreadListResponse = {
  threads: ThreadSummary[];
};

export type CreateThreadResponse = {
  thread: ThreadSummary;
};

export class BackendError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function uploadDeck(file?: File): Promise<UploadDeckResponse> {
  if (file) {
    const form = new FormData();
    form.append("file", file);
    return requestJson<UploadDeckResponse>("/api/decks/upload", {
      method: "POST",
      body: form,
    });
  }

  return requestJson<UploadDeckResponse>("/api/decks/upload", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
}

export async function getJob<T = unknown>(jobId: string): Promise<JobStatus<T>> {
  return requestJson<JobStatus<T>>(`/api/jobs/${jobId}`);
}

export async function pollJob<T>(
  jobId: string,
  onUpdate?: (job: JobStatus<T>) => void,
): Promise<JobStatus<T>> {
  const started = Date.now();
  while (Date.now() - started < 15_000) {
    const job = await getJob<T>(jobId);
    onUpdate?.(job);
    if (job.status === "succeeded") return job;
    if (job.status === "failed") {
      throw new BackendError(
        job.errorMessage ?? "Backend job failed.",
        "JOB_FAILED",
        500,
      );
    }
    await wait(160);
  }
  throw new BackendError("Backend job timed out.", "JOB_TIMEOUT", 408);
}

export async function getDeckStatus(deckId: string): Promise<DeckStatus> {
  return requestJson<DeckStatus>(`/api/decks/${deckId}/status`);
}

export async function getCurrentWorkspace(): Promise<CurrentWorkspaceResponse> {
  return requestJson<CurrentWorkspaceResponse>("/api/workspace/current");
}

export async function listThreads(deckId: string): Promise<ThreadListResponse> {
  return requestJson<ThreadListResponse>(`/api/decks/${deckId}/threads`);
}

export async function createThread(deckId: string): Promise<CreateThreadResponse> {
  return requestJson<CreateThreadResponse>(`/api/decks/${deckId}/threads`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
}

export async function requestEdit(
  input: RequestEditInput,
): Promise<EditRequestResponse> {
  return requestJson<EditRequestResponse>(
    `/api/decks/${input.deckId}/edit-requests`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        versionId: input.versionId,
        threadId: input.threadId,
        message: input.message,
        selectedSlideId: input.slideId,
        selectedSlideContext: input.selectedSlideContext,
        selectedElementIds: input.selectedElementIds,
        visibleSlideIds: input.visibleSlideIds,
        uiMode: "ready",
        clientContext: {
          activePanel: "agent",
          preferredOutput: "preserve_layout",
        },
      }),
    },
  );
}

export async function respondToDecision(
  deckId: string,
  decisionId: string,
  payload: DecisionResponsePayload,
): Promise<DecisionResponseResult> {
  return requestJson<DecisionResponseResult>(
    `/api/decks/${deckId}/decisions/${decisionId}/respond`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
}

export async function exportVersion(
  deckId: string,
  versionId: string,
): Promise<ExportVersionResponse> {
  return requestJson<ExportVersionResponse>(
    `/api/decks/${deckId}/versions/${versionId}/export`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    },
  );
}

export async function restoreVersion(
  deckId: string,
  versionId: string,
): Promise<{ uiState: "ready"; deckStatus: DeckStatus }> {
  return requestJson<{ uiState: "ready"; deckStatus: DeckStatus }>(
    `/api/decks/${deckId}/versions/${versionId}/restore`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    },
  );
}

async function requestJson<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, init);
  if (!response.ok) {
    let code = "BACKEND_ERROR";
    let message = `Backend request failed with ${response.status}.`;
    try {
      const body = (await response.json()) as {
        error?: { code?: string; message?: string };
      };
      code = body.error?.code ?? code;
      message = body.error?.message ?? message;
    } catch {
      // Keep the generic message if the backend did not return JSON.
    }
    throw new BackendError(message, code, response.status);
  }
  return (await response.json()) as T;
}
