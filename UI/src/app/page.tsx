"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowUp,
  Brain,
  Check,
  CircleDot,
  Cog,
  Download,
  FileUp,
  History,
  Image as ImageIcon,
  Loader2,
  MessageSquare,
  MoveRight,
  Pencil,
  Plus,
  Sparkles,
  X,
} from "lucide-react";

import {
  backendAssetUrl,
  createThread,
  emptyProgress,
  exportVersion,
  getCurrentWorkspace,
  getDeckStatus,
  listThreads,
  pollJob,
  requestEdit,
  respondToDecision,
  uploadDeck,
  type ApplyJobResult,
} from "@/lib/backend-client";
import type {
  ActivityDetailGroup,
  AgentEvent,
  ChipResponse,
  DecisionRequest,
  DeckStatus,
  PanelItem,
  ProcessingProgress,
  ProposalPreview,
  ReviewResult,
  Slide,
  ThreadSummary,
  ToolChip,
  ToolIcon,
  UiState,
} from "@/lib/deck-types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ModeToggle } from "@/components/mode-toggle";
import { cn } from "@/lib/utils";

const screenLabel: Record<UiState, string> = {
  upload_empty: "01 Upload",
  uploading: "02 Uploading",
  processing: "02 Processing",
  ready: "03 Workspace",
  planning: "04 Planning",
  awaiting_plan_approval: "04 Plan Approval",
  editing: "05 Applying",
  validating: "05 Validating",
  review_ready: "05 Review",
  accepted: "06 Export Ready",
};

const ICONS: Record<ToolIcon, React.ComponentType<{ className?: string }>> = {
  arrow: MoveRight,
  edit: Pencil,
  gear: Cog,
  image: ImageIcon,
  check: Check,
  download: Download,
  warning: AlertTriangle,
};

const WORKSPACE_STORAGE_KEY = "yc-startup-prospect.workspace.v1";

type StoredWorkspace = {
  deckId: string;
  activeVersionId: string;
  selectedSlideId: string;
  mode: UiState;
  panel: PanelItem[];
  activeThreadId?: string | null;
  panelByThreadId?: Record<string, PanelItem[]>;
  panelOpen: boolean;
  reviewResult: ReviewResult | null;
  proposalPreview: ProposalPreview | null;
  compareOpen: boolean;
};

function readStoredWorkspace(): StoredWorkspace | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(WORKSPACE_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as StoredWorkspace;
    return parsed?.deckId ? parsed : null;
  } catch {
    return null;
  }
}

function writeStoredWorkspace(workspace: StoredWorkspace): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(workspace));
}

function clearStoredWorkspace(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(WORKSPACE_STORAGE_KEY);
}

function chooseRestoredSlide(deck: DeckStatus, preferredSlideId?: string): string {
  return (
    deck.slides.find((slide) => slide.slideId === preferredSlideId)?.slideId ??
    deck.slides[0]?.slideId ??
    "slide_1"
  );
}

function resolveRestoredMode(
  storedMode?: UiState,
  storedReview?: ReviewResult | null,
): UiState {
  if (storedReview && (storedMode === "review_ready" || storedMode === "accepted")) {
    return storedMode;
  }
  if (storedMode === "accepted") return "accepted";
  return "ready";
}

function makeLocalItemId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function buildPlanAssistantTurn(
  events: AgentEvent[],
  proposal: ProposalPreview,
  slide?: Slide,
): PanelItem[] {
  const chips = chipsFromEvents(events);
  const target = chips.find((chip) => chip.verb === "resolve_target");
  const plan = chips.find((chip) => chip.verb === "create_plan");
  const operation = proposal.operations.find(
    (candidate) => candidate.operationType !== "fit_text",
  );
  const slideLabel = slide?.slideId === proposal.slideId ? `Slide ${slide.number}` : proposal.slideId;
  const isBackground = operation?.operationType === "set_slide_background";
  return [
    ...reasoningItemsFromEvents(events),
    {
      kind: "assistant_summary",
      itemId: makeLocalItemId("assistant"),
      text: isBackground
        ? `I prepared a preview for the background color on ${slideLabel}.`
        : `I found the editable text target on ${slideLabel} and prepared a preview.`,
      details: compactDetailGroups([
        {
          label: "Target",
          rows: [
            { label: "Slide", value: slideLabel },
            { label: "Element", value: proposal.targetRefs.join(", ") },
            ...(target?.subtitle ? [{ label: "Resolution", value: target.subtitle }] : []),
          ],
        },
        {
          label: "Change",
          rows: operation
            ? [
                { label: "Before", value: operation.before },
                { label: "After", value: operation.after },
              ]
            : [{ label: "Operations", value: String(proposal.operations.length) }],
        },
        {
          label: "Plan",
          rows: [
            { label: "Plan", value: proposal.planId },
            { label: "Version", value: proposal.versionId },
            ...(plan?.subtitle ? [{ label: "Summary", value: plan.subtitle }] : []),
          ],
        },
      ]),
    },
    ...chips
      .filter((chip) => chip.verb === "apply_plan")
      .map((chip) => ({ kind: "chip" as const, itemId: chip.chipId, chip })),
  ];
}

function buildClarificationAssistantTurn(
  events: AgentEvent[],
  decisionRequest: DecisionRequest,
): PanelItem[] {
  const chips = chipsFromEvents(events);
  const resolve = chips.find((chip) => chip.verb === "resolve_target");
  return [
    ...reasoningItemsFromEvents(events),
    {
      kind: "assistant_summary",
      itemId: makeLocalItemId("assistant"),
      text: "I need the exact text target before I can update the slide.",
    },
    {
      kind: "chip",
      itemId: resolve?.chipId ?? decisionRequest.decisionId,
      chip:
        resolve ?? {
          chipId: decisionRequest.decisionId,
          verb: "resolve_target",
          status: "awaiting_input",
          icon: "warning",
          purpose: "choose_target",
          title: decisionRequest.title,
          subtitle: decisionRequest.context,
          input: decisionRequest.options?.length
            ? { mode: "single_choice", options: decisionRequest.options }
            : { mode: "free_text", placeholder: "Describe which text box to edit" },
        },
    },
  ];
}

function reasoningItemsFromEvents(events: AgentEvent[]): PanelItem[] {
  const reasoning = events.filter((event) => event.type === "reasoning");
  if (!reasoning.length) return [];
  return [
    {
      kind: "reasoning",
      itemId: makeLocalItemId("reasoning"),
      title: "Reasoning",
      events: reasoning.map((event) => ({
        itemId: event.itemId,
        status: event.status,
        text: event.text,
      })),
    },
  ];
}

function buildAppliedAssistantTurn(): PanelItem[] {
  return [
    {
      kind: "assistant_summary",
      itemId: makeLocalItemId("assistant"),
      text: "Done. Updated the slide.",
    },
  ];
}

function buildDecisionResultSummary(
  response: ChipResponse,
): PanelItem[] {
  if (response.verb === "apply_plan") {
    const refined = response.selectedId === "refine";
    return [
      {
        kind: "assistant_summary",
        itemId: makeLocalItemId("assistant"),
        text: refined
          ? "I rejected that preview so you can refine the instruction."
          : "I rejected the preview. The deck was not changed.",
      },
    ];
  }
  if (response.verb === "accept_version") {
    const selected = response.selectedId;
    const text =
      selected === "accept"
        ? "Accepted. This version is now ready to export."
        : selected === "refine"
          ? "Kept this edit active so you can refine it further."
          : "Rejected. I restored the previous working version.";
    return [
      {
        kind: "assistant_summary",
        itemId: makeLocalItemId("assistant"),
        text,
      },
    ];
  }
  if (response.verb === "resolve_target") {
    return [
      {
        kind: "assistant_summary",
        itemId: makeLocalItemId("assistant"),
        text: "Target clarification captured. Send the edit prompt again to prepare the preview.",
      },
    ];
  }
  return [];
}

function chipsFromEvents(events: AgentEvent[]): ToolChip[] {
  const chips = new Map<string, ToolChip>();
  for (const event of events) {
    if (event.type === "tool_start") {
      chips.set(event.chip.chipId, event.chip);
    }
    if (event.type === "tool_update" || event.type === "tool_complete") {
      const existing = chips.get(event.chipId);
      if (existing) chips.set(event.chipId, { ...existing, ...event.patch });
    }
  }
  return [...chips.values()];
}

function compactDetailGroups(groups: ActivityDetailGroup[]): ActivityDetailGroup[] {
  return groups
    .map((group) => ({
      ...group,
      rows: group.rows.filter((row) => row.value.trim().length > 0),
    }))
    .filter((group) => group.rows.length > 0);
}

function markDecisionDone(panel: PanelItem[], decisionId: string): PanelItem[] {
  return panel.map((item) =>
    item.kind === "decision" && item.decisionId === decisionId
      ? { ...item, status: "done" }
      : item.kind === "chip" && item.chip.chipId === decisionId
        ? { ...item, chip: { ...item.chip, status: "done", input: undefined } }
      : item,
  );
}

function cleanStoredPanel(panel: PanelItem[] = []): PanelItem[] {
  const cleaned: PanelItem[] = [];
  for (const item of panel) {
    if (
      item.kind === "chip" ||
      item.kind === "reasoning" ||
      item.kind === "decision" ||
      (item.kind === "prose" && item.streaming)
    ) {
      continue;
    }
    if (item.kind === "assistant_summary") {
      cleaned.push({ ...item, actions: undefined, details: undefined });
      continue;
    }
    cleaned.push(item);
  }
  return cleaned;
}

function cleanStoredPanelMap(
  panels: Record<string, PanelItem[]> = {},
): Record<string, PanelItem[]> {
  return Object.fromEntries(
    Object.entries(panels).map(([threadId, items]) => [
      threadId,
      cleanStoredPanel(items),
    ]),
  );
}

function modeAcceptsNewPrompt(mode: UiState): boolean {
  return mode === "ready" || mode === "review_ready" || mode === "accepted";
}

export default function Home() {
  const [mode, setMode] = useState<UiState>("upload_empty");
  const [deck, setDeck] = useState<DeckStatus | null>(null);
  const [selectedSlideId, setSelectedSlideId] = useState("slide_1");
  const [progress, setProgress] = useState<ProcessingProgress>(emptyProgress);
  const [prompt, setPrompt] = useState("");
  const [exported, setExported] = useState(false);
  const [reviewResult, setReviewResult] = useState<ReviewResult | null>(null);
  const [proposalPreview, setProposalPreview] = useState<ProposalPreview | null>(null);
  const [compareOpen, setCompareOpen] = useState(false);
  const [panel, setPanel] = useState<PanelItem[]>([]);
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [panelByThreadId, setPanelByThreadId] = useState<Record<string, PanelItem[]>>({});
  const [panelOpen, setPanelOpen] = useState(true);
  const [sessionHydrated, setSessionHydrated] = useState(false);

  const clearPanel = useCallback(() => {
    setPanel([]);
  }, []);

  const selectedSlide = useMemo(
    () => deck?.slides.find((slide) => slide.slideId === selectedSlideId),
    [deck, selectedSlideId],
  );

  const hasBlockingChip = useMemo(
    () =>
      panel.some((it) => {
        if (it.kind === "chip") {
          return (
            it.chip.status === "awaiting_input" ||
            it.chip.status === "submitting" ||
            it.chip.status === "running"
          );
        }
        if (it.kind === "decision") {
          return it.status === "awaiting_input" || it.status === "submitting";
        }
        return false;
      }),
    [panel],
  );

  const composerEnabled = modeAcceptsNewPrompt(mode) && !hasBlockingChip;
  const threadControlsDisabled =
    !deck ||
    hasBlockingChip ||
    mode === "planning" ||
    mode === "editing" ||
    mode === "validating";

  async function handleCreateThread() {
    if (!deck || threadControlsDisabled) return;
    try {
      const result = await createThread(deck.deckId);
      const nextPanelByThreadId = activeThreadId
        ? { ...panelByThreadId, [activeThreadId]: panel }
        : panelByThreadId;
      setPanelByThreadId(nextPanelByThreadId);
      setThreads((prev) => [
        result.thread,
        ...prev.filter((thread) => thread.threadId !== result.thread.threadId),
      ]);
      setActiveThreadId(result.thread.threadId);
      setPanel([]);
      setPrompt("");
      setReviewResult(null);
      setProposalPreview(null);
      setCompareOpen(false);
      setMode("ready");
    } catch (error) {
      console.error(error);
    }
  }

  function handleSelectThread(threadId: string) {
    if (threadControlsDisabled || threadId === activeThreadId) return;
    const nextPanelByThreadId = activeThreadId
      ? { ...panelByThreadId, [activeThreadId]: panel }
      : panelByThreadId;
    setPanelByThreadId(nextPanelByThreadId);
    setActiveThreadId(threadId);
    setPanel(nextPanelByThreadId[threadId] ?? []);
    setPrompt("");
    setReviewResult(null);
    setProposalPreview(null);
    setCompareOpen(false);
    setMode("ready");
  }

  async function refreshThreads(deckId: string) {
    try {
      const refreshed = await listThreads(deckId);
      setThreads(refreshed.threads);
    } catch (error) {
      console.error(error);
    }
  }

  useEffect(() => {
    let cancelled = false;

    async function restoreWorkspace() {
      const stored = readStoredWorkspace();
      try {
        const restoredDeck = stored?.deckId
          ? await getDeckStatus(stored.deckId)
          : (await getCurrentWorkspace()).deckStatus;
        if (cancelled) return;
        if (!restoredDeck) {
          setMode("upload_empty");
          return;
        }
        const storedMatchesActiveVersion =
          stored?.activeVersionId === restoredDeck.activeVersionId;
        const restoredReview = storedMatchesActiveVersion
          ? (stored?.reviewResult ?? null)
          : null;
        const restoredSlideId = chooseRestoredSlide(
          restoredDeck,
          stored?.selectedSlideId,
        );
        const restoredThreads = (await listThreads(restoredDeck.deckId)).threads;
        if (cancelled) return;
        const storedPanelByThreadId = storedMatchesActiveVersion
          ? cleanStoredPanelMap(stored?.panelByThreadId)
          : {};
        const restoredThreadId =
          restoredThreads.find((thread) => thread.threadId === stored?.activeThreadId)
            ?.threadId ??
          restoredThreads[0]?.threadId ??
          null;
        const restoredPanel =
          storedMatchesActiveVersion && restoredThreadId
            ? (storedPanelByThreadId[restoredThreadId] ?? cleanStoredPanel(stored?.panel))
            : storedMatchesActiveVersion
              ? cleanStoredPanel(stored?.panel)
              : [];
        setDeck(restoredDeck);
        setSelectedSlideId(restoredSlideId);
        setThreads(restoredThreads);
        setActiveThreadId(restoredThreadId);
        setPanelByThreadId(storedPanelByThreadId);
        setPanel(restoredPanel);
        setPanelOpen(stored?.panelOpen ?? true);
        setReviewResult(restoredReview);
        setProposalPreview(null);
        setCompareOpen(storedMatchesActiveVersion ? (stored?.compareOpen ?? false) : false);
        setMode(resolveRestoredMode(stored?.mode, restoredReview));
      } catch (error) {
        console.error(error);
        clearStoredWorkspace();
        try {
          const current = await getCurrentWorkspace();
          if (cancelled) return;
          if (current.deckStatus) {
            setDeck(current.deckStatus);
            setSelectedSlideId(chooseRestoredSlide(current.deckStatus));
            const currentThreads = (await listThreads(current.deckStatus.deckId)).threads;
            if (cancelled) return;
            setThreads(currentThreads);
            setActiveThreadId(currentThreads[0]?.threadId ?? null);
            setMode("ready");
          } else {
            setMode("upload_empty");
          }
        } catch (fallbackError) {
          console.error(fallbackError);
          if (!cancelled) setMode("upload_empty");
        }
      } finally {
        if (!cancelled) setSessionHydrated(true);
      }
    }

    void restoreWorkspace();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!sessionHydrated) return;
    if (!deck) {
      if (mode === "upload_empty") clearStoredWorkspace();
      return;
    }
    const nextPanelByThreadId = activeThreadId
      ? { ...panelByThreadId, [activeThreadId]: panel }
      : panelByThreadId;
    writeStoredWorkspace({
      deckId: deck.deckId,
      activeVersionId: deck.activeVersionId,
      selectedSlideId,
      mode,
      panel,
      activeThreadId,
      panelByThreadId: nextPanelByThreadId,
      panelOpen,
      reviewResult,
      proposalPreview,
      compareOpen,
    });
  }, [
    compareOpen,
    activeThreadId,
    deck,
    mode,
    panel,
    panelByThreadId,
    panelOpen,
    proposalPreview,
    reviewResult,
    selectedSlideId,
    sessionHydrated,
  ]);

  function jumpToWorkspace() {
    void startUpload();
  }

  async function startUpload(file?: File) {
    try {
      clearPanel();
      setPrompt("");
      setExported(false);
      setReviewResult(null);
      setProposalPreview(null);
      setCompareOpen(false);
      setThreads([]);
      setActiveThreadId(null);
      setPanelByThreadId({});
      setDeck(null);
      setMode("uploading");
      setProgress(emptyProgress);

      const upload = await uploadDeck(file);
      setMode("processing");
      const job = await pollJob(upload.jobId, (nextJob) => {
        setProgress(nextJob.progress);
      });
      setProgress(job.progress);

      const readyDeck = await getDeckStatus(upload.deckId);
      const readyThreads = (await listThreads(upload.deckId)).threads;
      setDeck(readyDeck);
      setThreads(readyThreads);
      setActiveThreadId(readyThreads[0]?.threadId ?? null);
      setSelectedSlideId(chooseRestoredSlide(readyDeck));
      setMode("ready");
    } catch (error) {
      console.error(error);
      setMode("upload_empty");
    }
  }

  async function submitPrompt() {
    if (!deck || !prompt.trim() || !composerEnabled) return;
    const message = prompt.trim();
    const planningItemId = makeLocalItemId("planning");
    setPrompt("");
    setExported(false);
    setReviewResult(null);
    setProposalPreview(null);
    setCompareOpen(false);
    setPanel((prev) => [
      ...prev,
      { kind: "user", itemId: makeLocalItemId("user"), text: message },
      {
        kind: "reasoning",
        itemId: planningItemId,
        title: "Reasoning",
        events: [
          {
            itemId: `${planningItemId}_event`,
            status: "running",
            text: "Preparing the edit preview.",
          },
        ],
      },
    ]);
    setMode("planning");

    try {
      const result = await requestEdit({
        deckId: deck.deckId,
        versionId: deck.activeVersionId,
        threadId: activeThreadId ?? undefined,
        slideId: selectedSlideId,
        selectedSlideContext: selectedSlide
          ? {
              slideId: selectedSlide.slideId,
              number: selectedSlide.number,
              title: selectedSlide.title,
              subtitle: selectedSlide.subtitle,
              activeVersionId: deck.activeVersionId,
            }
          : undefined,
        selectedElementIds: [],
        visibleSlideIds: deck.slides.map((slide) => slide.slideId),
        message,
      });
      setActiveThreadId(result.threadId);
      void refreshThreads(deck.deckId);
      if (result.proposalPreview) {
        setPanel((prev) => [
          ...prev.filter((item) => item.itemId !== planningItemId),
          ...buildPlanAssistantTurn(result.events, result.proposalPreview!, selectedSlide),
        ]);
        setProposalPreview(result.proposalPreview);
        setCompareOpen(false);
        setMode("awaiting_plan_approval");
      } else {
        setPanel((prev) => [
          ...prev.filter((item) => item.itemId !== planningItemId),
          ...buildClarificationAssistantTurn(result.events, result.decisionRequest),
        ]);
        setProposalPreview(null);
        setCompareOpen(false);
        setMode(result.uiState);
      }
    } catch (error) {
      console.error(error);
      setPanel((prev) => [
        ...prev.filter((item) => item.itemId !== planningItemId),
        {
          kind: "prose",
          itemId: makeLocalItemId("error"),
          text:
            error instanceof Error
              ? `Preview failed: ${error.message}`
              : "Preview failed. Try again.",
          streaming: false,
        },
      ]);
      setPrompt(message);
      setMode("ready");
    }
  }

  async function onChipResponse(response: ChipResponse) {
    if (!deck) return;
    try {
      setPanel((prev) =>
        prev.map((item) =>
          item.kind === "decision" && item.decisionId === response.chipId
            ? { ...item, status: "submitting" }
            : item.kind === "chip" && item.chip.chipId === response.chipId
              ? { ...item, chip: { ...item.chip, status: "submitting" } }
            : item,
        ),
      );
      if (response.verb === "apply_plan") {
        setProposalPreview(null);
        setCompareOpen(false);
      }
      const result = await respondToDecision(deck.deckId, response.chipId, {
        versionId: deck.activeVersionId,
        selectedOptionId: response.selectedId,
        answerText: response.answerText,
      });

      if (result.jobId) {
        setMode(result.uiState);
        const job = await pollJob<ApplyJobResult>(result.jobId);
        if (job.result?.deckStatus) setDeck(job.result.deckStatus);
        if (job.result?.reviewResult) {
          setReviewResult(job.result.reviewResult);
          setMode("review_ready");
        }
        if (job.result?.events && job.result.reviewResult) {
          setPanel((prev) => [
            ...markDecisionDone(prev, response.chipId),
            ...buildAppliedAssistantTurn(),
          ]);
        }
        void refreshThreads(deck.deckId);
        return;
      }

      if (result.deckStatus) setDeck(result.deckStatus);
      if (response.verb === "apply_plan" && response.selectedId !== "apply") {
        setPrompt("");
        setProposalPreview(null);
        setCompareOpen(false);
      }
      if (response.verb === "accept_version" && response.selectedId === "reject") {
        setExported(false);
        setReviewResult(null);
        setCompareOpen(false);
      }
      if (response.verb === "accept_version" && response.selectedId === "refine") {
        setExported(false);
        setReviewResult(null);
        setCompareOpen(false);
      }
      setPanel((prev) => [
        ...markDecisionDone(prev, response.chipId),
        ...buildDecisionResultSummary(response),
      ]);
      setMode(result.uiState);
      void refreshThreads(deck.deckId);
    } catch (error) {
      console.error(error);
      setPanel((prev) => [
        ...markDecisionDone(prev, response.chipId),
        {
          kind: "assistant_summary",
          itemId: makeLocalItemId("assistant"),
          text:
            error instanceof Error
              ? `That action failed: ${error.message}`
              : "That action failed. Please try again.",
        },
      ]);
    }
  }

  async function handleExportClick() {
    if (!deck) return;
    try {
      const result = await exportVersion(deck.deckId, deck.activeVersionId);
      setDeck(result.deckStatus);
      setExported(true);
      setMode(result.uiState);
    } catch (error) {
      console.error(error);
    }
  }

  const workspaceVisible =
    mode !== "upload_empty" && mode !== "uploading" && mode !== "processing";

  return (
    <main className="min-h-screen bg-muted/40 text-foreground">
      <TopBar
        mode={mode}
        deck={deck}
        exported={exported}
        onExportClick={handleExportClick}
      />

      {!workspaceVisible ? (
        <div className="flex min-h-[calc(100vh-57px)] items-center justify-center px-6 py-8">
          {mode === "upload_empty" ? (
            <UploadScreen onUpload={startUpload} onSkip={jumpToWorkspace} />
          ) : (
            <ProcessingScreen progress={progress} />
          )}
        </div>
      ) : (
        <div className="grid h-[calc(100dvh-56px)] grid-rows-[1fr_44px] overflow-hidden">
          <div
            className={cn(
              "grid min-h-0 border-b bg-background",
              panelOpen
                ? "grid-cols-[236px_minmax(520px,1fr)_412px]"
                : "grid-cols-[236px_minmax(520px,1fr)]",
            )}
          >
            <SlideRail
              deck={deck}
              selectedSlideId={selectedSlideId}
              onSelect={setSelectedSlideId}
            />
            <RenderCanvas
              mode={mode}
              slide={selectedSlide}
              activeVersionId={deck?.activeVersionId ?? "v1"}
              reviewResult={reviewResult}
              proposalPreview={proposalPreview}
              compareOpen={compareOpen}
              onCompareOpenChange={setCompareOpen}
            />
            {panelOpen ? (
              <div className="min-h-0 p-3 pl-0">
                <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border bg-background shadow-xl">
                  <AgentPanel
                    panel={panel}
                    threads={threads}
                    activeThreadId={activeThreadId}
                    threadControlsDisabled={threadControlsDisabled}
                    prompt={prompt}
                    composerEnabled={composerEnabled}
                    composerPlaceholder={composerPlaceholder(mode, hasBlockingChip)}
                    onCreateThread={handleCreateThread}
                    onSelectThread={handleSelectThread}
                    onPromptChange={setPrompt}
                    onSubmitPrompt={submitPrompt}
                    onChipResponse={onChipResponse}
                    onClose={() => setPanelOpen(false)}
                  />
                </div>
              </div>
            ) : null}
          </div>
          <TrustStrip deck={deck} mode={mode} exported={exported} />
          {!panelOpen ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon"
                  onClick={() => setPanelOpen(true)}
                  aria-label="Open agent panel"
                  className="fixed bottom-[60px] right-4 z-40 size-12 rounded-full shadow-lg"
                >
                  <Sparkles className="size-5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="left">Deck agent</TooltipContent>
            </Tooltip>
          ) : null}
        </div>
      )}
    </main>
  );
}

function composerPlaceholder(mode: UiState, hasBlockingChip: boolean): string {
  if (mode === "upload_empty") return "Upload a deck to begin.";
  if (modeAcceptsNewPrompt(mode) && !hasBlockingChip) return "Describe an edit...";
  if (hasBlockingChip) return "Respond on the chip above to continue.";
  return "Agent is working…";
}

// ----- TopBar / Upload / Processing (unchanged behavior) -----

function TopBar({
  mode,
  deck,
  exported,
  onExportClick,
}: {
  mode: UiState;
  deck: DeckStatus | null;
  exported: boolean;
  onExportClick: () => void;
}) {
  const canExport = Boolean(deck?.validationSummary.canExport);
  return (
    <header className="flex h-14 items-center justify-between border-b bg-background px-5">
      <div className="flex items-center gap-3">
        <div className="flex size-8 items-center justify-center rounded-lg border bg-foreground text-background">
          <Sparkles className="size-4" />
        </div>
        <div>
          <div className="text-sm font-semibold leading-4">
            Deck Review Workspace
          </div>
          <div className="text-xs text-muted-foreground">
            Plan, approve, render, validate, export
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <ModeToggle />
        <Badge variant="outline" className="rounded-md">
          {screenLabel[mode]}
        </Badge>
        <Badge variant="secondary" className="rounded-md">
          {deck?.fileName ?? "No deck loaded"}
        </Badge>
        {canExport ? (
          <Button
            size="sm"
            variant={exported ? "outline" : "default"}
            onClick={onExportClick}
            disabled={exported}
          >
            <ArrowDownToLine className="size-3.5" />
            {exported ? "Export prepared" : "Export PPTX"}
          </Button>
        ) : null}
      </div>
    </header>
  );
}

function UploadScreen({
  onUpload,
  onSkip,
}: {
  onUpload: (file: File) => void;
  onSkip: () => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  function openFilePicker() {
    fileInputRef.current?.click();
  }

  function handleFile(file?: File) {
    if (!file) return;
    onUpload(file);
  }

  return (
    <Card className="w-full max-w-[560px] rounded-lg border bg-card shadow-none">
      <CardHeader className="border-b">
        <CardTitle className="text-base">Upload PPTX</CardTitle>
        <CardAction>
          <Badge variant="outline" className="rounded-md">
            .pptx only
          </Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="pt-6">
        <input
          ref={fileInputRef}
          type="file"
          accept=".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation"
          className="hidden"
          onChange={(event) => handleFile(event.target.files?.[0])}
        />
        <button
          type="button"
          onClick={openFilePicker}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            handleFile(event.dataTransfer.files[0]);
          }}
          className="flex w-full flex-col items-center justify-center gap-4 rounded-lg border border-dashed bg-muted/40 px-8 py-14 text-center transition hover:bg-muted"
        >
          <span className="flex size-12 items-center justify-center rounded-full border bg-background">
            <FileUp className="size-5" />
          </span>
          <span>
            <span className="block text-lg font-semibold">
              Drop a presentation here
            </span>
            <span className="mt-1 block text-sm text-muted-foreground">
              Browse from your device or drop a .pptx to upload it.
            </span>
          </span>
        </button>
        <div className="mt-4 flex items-center justify-center">
          <Button type="button" onClick={openFilePicker}>
            <FileUp className="size-4" />
            Browse PPTX
          </Button>
        </div>
        <div className="mt-5 grid grid-cols-3 gap-2 text-xs text-muted-foreground">
          <div className="rounded-md border bg-card px-3 py-2">
            Original preserved
          </div>
          <div className="rounded-md border bg-card px-3 py-2">
            Backend renders
          </div>
          <div className="rounded-md border bg-card px-3 py-2">
            Approval required
          </div>
        </div>
        <div className="mt-4 flex items-center justify-center">
          <button
            type="button"
            onClick={onSkip}
            className="text-xs text-muted-foreground underline-offset-4 transition hover:text-foreground hover:underline"
          >
            Load backend sample instead →
          </button>
        </div>
      </CardContent>
    </Card>
  );
}

function ProcessingScreen({ progress }: { progress: ProcessingProgress }) {
  const rows = [
    ["Upload complete", progress.upload],
    ["Parsing structure", progress.parse],
    ["Rendering slides", progress.render],
    ["Running validation", progress.validate],
  ] as const;

  return (
    <Card className="w-full max-w-[760px] rounded-lg border bg-card shadow-none">
      <CardHeader className="border-b">
        <CardTitle className="flex items-center gap-2 text-base">
          <Loader2 className="size-4 animate-spin" />
          Processing deck
        </CardTitle>
        <CardAction>
          <Badge variant="secondary" className="rounded-md">
            backend pipeline
          </Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-6 pt-6">
        <div className="grid gap-4">
          {rows.map(([label, value]) => (
            <div
              key={label}
              className="grid grid-cols-[160px_1fr_44px] items-center gap-4"
            >
              <div className="text-sm font-medium">{label}</div>
              <Progress value={value} />
              <div className="text-right text-xs text-muted-foreground">
                {value}%
              </div>
            </div>
          ))}
        </div>
        <div className="grid grid-cols-6 gap-3">
          {Array.from({ length: 6 }).map((_, index) => (
            <div
              key={index}
              className={cn(
                "aspect-video rounded-md border bg-muted/50",
                progress.render > index * 16 && "bg-card",
              )}
            >
              <div className="h-full p-2">
                <div className="mb-2 h-2 w-1/2 rounded bg-muted-foreground/40" />
                <div className="h-1.5 w-full rounded bg-border" />
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// ----- SlideRail (unchanged) -----

function SlideRail({
  deck,
  selectedSlideId,
  onSelect,
}: {
  deck: DeckStatus | null;
  selectedSlideId: string;
  onSelect: (slideId: string) => void;
}) {
  return (
    <aside className="min-h-0 border-r bg-muted/30">
      <div className="flex h-12 items-center justify-between border-b px-4">
        <div className="text-sm font-semibold">Slides</div>
        <Badge variant="outline" className="rounded-md">
          {deck?.slides.length ?? 0}
        </Badge>
      </div>
      <ScrollArea className="h-[calc(100%-193px)]">
        <div className="space-y-2 p-3">
          {deck?.slides.map((slide) => (
            <SlideThumb
              key={slide.slideId}
              slide={slide}
              selected={selectedSlideId === slide.slideId}
              status={deck.slideStatuses[slide.slideId]}
              onSelect={() => onSelect(slide.slideId)}
            />
          ))}
        </div>
      </ScrollArea>
      <div className="h-[145px] border-t p-3">
        <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
          <History className="size-4" />
          Timeline
        </div>
        <div className="space-y-2">
          {deck?.versions.map((version) => (
            <div key={version.id} className="flex items-center gap-2 text-xs">
              <CircleDot className="size-3 text-muted-foreground" />
              <span className="truncate">{version.label}</span>
              {version.id === deck.activeVersionId ? (
                <Badge variant="secondary" className="ml-auto rounded-md">
                  active
                </Badge>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
}

function SlideThumb({
  slide,
  selected,
  status,
  onSelect,
}: {
  slide: Slide;
  selected: boolean;
  status: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "w-full rounded-lg border bg-card p-2 text-left transition",
        selected ? "border-foreground bg-accent shadow-sm" : "hover:bg-accent",
      )}
    >
      <div className="aspect-video rounded-md border bg-muted/40 p-2">
        {slide.thumbnailUrl ? (
          <img
            src={backendAssetUrl(slide.thumbnailUrl)}
            alt={`Slide ${slide.number} thumbnail`}
            className="h-full w-full rounded-sm object-cover"
          />
        ) : (
          <>
            <div className="h-2 w-3/4 rounded bg-foreground" />
            <div className="mt-3 h-1.5 w-full rounded bg-muted-foreground/40" />
            <div className="mt-1.5 h-1.5 w-2/3 rounded bg-border" />
          </>
        )}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <div className="min-w-0 flex-1 truncate text-xs font-medium">
          Slide {slide.number}
        </div>
        {status !== "ready" ? (
          <Badge variant="outline" className="rounded-md text-[10px]">
            {status}
          </Badge>
        ) : null}
      </div>
    </button>
  );
}

// ----- RenderCanvas -----

function RenderCanvas({
  mode,
  slide,
  activeVersionId,
  reviewResult,
  proposalPreview,
  compareOpen,
  onCompareOpenChange,
}: {
  mode: UiState;
  slide?: Slide;
  activeVersionId: string;
  reviewResult: ReviewResult | null;
  proposalPreview: ProposalPreview | null;
  compareOpen: boolean;
  onCompareOpenChange: (open: boolean) => void;
}) {
  const reviewMode = mode === "review_ready" || mode === "accepted";
  const activeProposal =
    mode === "awaiting_plan_approval" && proposalPreview?.slideId === slide?.slideId
      ? proposalPreview
      : null;
  const selectedReviewPreview = reviewResult?.slidePreviews.find(
    (preview) => preview.slideId === slide?.slideId,
  );
  const reviewPreview = selectedReviewPreview;
  const beforeSlide =
    slide && reviewPreview
      ? {
          ...slide,
          title: reviewPreview.before.title,
          subtitle: reviewPreview.before.subtitle,
          renderUrl: reviewPreview.before.renderUrl,
        }
      : slide;
  const afterSlide =
    slide && selectedReviewPreview
      ? {
          ...slide,
          title: selectedReviewPreview.after.title,
          subtitle: selectedReviewPreview.after.subtitle,
          renderUrl: selectedReviewPreview.after.renderUrl,
        }
      : slide;
  const proposalSlide =
    slide && activeProposal
      ? {
          ...slide,
          renderUrl: activeProposal.renderUrl,
        }
      : slide;
  const canCompare = Boolean(activeProposal || selectedReviewPreview);
  const activeSlide = activeProposal ? proposalSlide : afterSlide;
  const activeTitle = activeProposal
    ? "Proposed preview"
    : reviewMode && selectedReviewPreview
      ? "Applied render"
      : "Current render";

  return (
    <section className="flex min-h-0 min-w-0 flex-col bg-background">
      <div className="flex h-12 items-center justify-between border-b bg-background px-5">
        <div>
          <div className="text-sm font-semibold">
            {activeProposal ? "Inline slide preview" : "Rendered slide"}
          </div>
          <div className="text-xs text-muted-foreground">
            {activeProposal
              ? "Preview only. The PPTX changes after Apply."
              : reviewMode
                ? "Current backend render. Compare is available on demand."
                : "Current backend render."}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {canCompare ? (
            <Button
              size="sm"
              variant={compareOpen ? "secondary" : "outline"}
              onClick={() => onCompareOpenChange(!compareOpen)}
            >
              {compareOpen ? "Hide Compare" : "Compare"}
            </Button>
          ) : null}
          <Badge variant={activeProposal ? "secondary" : "outline"} className="rounded-md">
            {activeProposal ? "Preview" : slide ? `Slide ${slide.number}` : "No slide"}
          </Badge>
        </div>
      </div>
      <div className="min-h-0 flex-1 p-4 lg:p-6">
        {compareOpen && activeProposal ? (
          <div className="grid h-full min-h-0 w-full grid-cols-2 gap-5">
            <SlideRender title="Current" slide={slide} version={activeVersionId} />
            <SlideRender
              title="Proposed"
              slide={proposalSlide}
              version={activeProposal.versionId}
              changed
            />
          </div>
        ) : compareOpen && reviewPreview ? (
          <div className="grid h-full min-h-0 w-full grid-cols-2 gap-5">
            <SlideRender
              title="Before"
              slide={beforeSlide}
              version={
                reviewPreview?.before.versionId ??
                reviewResult?.inputVersionId ??
                activeVersionId
              }
            />
            <SlideRender
              title="After"
              slide={
                slide && reviewPreview
                  ? {
                      ...slide,
                      title: reviewPreview.after.title,
                      subtitle: reviewPreview.after.subtitle,
                      renderUrl: reviewPreview.after.renderUrl,
                    }
                  : slide
              }
              version={
                reviewPreview?.after.versionId ??
                reviewResult?.outputVersionId ??
                activeVersionId
              }
              changed
            />
          </div>
        ) : (
          <div className="grid h-full min-h-0 w-full grid-rows-[minmax(0,1fr)_auto]">
            <SlideRender
              title={activeTitle}
              slide={activeSlide}
              version={activeVersionId}
              highlighted={Boolean(activeProposal)}
              changed={Boolean(activeProposal || selectedReviewPreview)}
              showCaption={false}
            />
            {activeProposal ? (
              <div className="mt-3 rounded-lg border bg-muted/30 px-4 py-3 text-sm">
                <div className="font-medium">Pending change on this slide</div>
                <div className="truncate text-xs text-muted-foreground">
                  {activeProposal.targetRefs.join(" · ")}
                </div>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </section>
  );
}

const MIN_CANVAS_ZOOM = 0.25;
const MAX_CANVAS_ZOOM = 12;
const CANVAS_ZOOM_SPEED = 0.004;

function SlideRender({
  title,
  slide,
  version,
  highlighted,
  changed,
  showCaption = true,
}: {
  title: string;
  slide?: Slide;
  version: string;
  highlighted?: boolean;
  changed?: boolean;
  showCaption?: boolean;
}) {
  const slideKey = `${slide?.slideId ?? "empty"}:${slide?.renderUrl ?? "fallback"}`;

  return (
    <figure className="flex h-full min-h-0 w-full flex-col">
      {showCaption ? (
        <figcaption className="mb-2 flex h-7 shrink-0 items-center justify-between gap-3">
          <div className="truncate text-sm font-semibold">{title}</div>
          <Badge variant={changed ? "secondary" : "outline"} className="rounded-md">
            {version}
          </Badge>
        </figcaption>
      ) : null}
      <InfiniteSlideCanvas
        key={slideKey}
        title={title}
        version={version}
        slide={slide}
        highlighted={highlighted}
      />
    </figure>
  );
}

function InfiniteSlideCanvas({
  title,
  version,
  slide,
  highlighted,
}: {
  title: string;
  version: string;
  slide?: Slide;
  highlighted?: boolean;
}) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    function handleWheel(event: WheelEvent) {
      event.preventDefault();
      event.stopPropagation();

      const bounds = canvasRef.current?.getBoundingClientRect();
      if (!bounds) return;
      const pointerX = event.clientX - bounds.left;
      const pointerY = event.clientY - bounds.top;

      setView((current) => {
        const nextScale = Math.min(
          MAX_CANVAS_ZOOM,
          Math.max(
            MIN_CANVAS_ZOOM,
            current.scale * Math.exp(-event.deltaY * CANVAS_ZOOM_SPEED),
          ),
        );
        const ratio = nextScale / current.scale;

        return {
          scale: nextScale,
          x: pointerX - (pointerX - current.x) * ratio,
          y: pointerY - (pointerY - current.y) * ratio,
        };
      });
    }

    canvas.addEventListener("wheel", handleWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", handleWheel);
  }, []);

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      dragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        originX: view.x,
        originY: view.y,
      };
      setDragging(true);
    },
    [view.x, view.y],
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      event.preventDefault();
      setView((current) => ({
        ...current,
        x: drag.originX + event.clientX - drag.startX,
        y: drag.originY + event.clientY - drag.startY,
      }));
    },
    [],
  );

  const endDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragRef.current = null;
    setDragging(false);
  }, []);

  const resetView = useCallback(() => {
    dragRef.current = null;
    setDragging(false);
    setView({ x: 0, y: 0, scale: 1 });
  }, []);

  return (
    <div
      ref={canvasRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={resetView}
      className={cn(
        "relative min-h-0 flex-1 overflow-hidden bg-background select-none touch-none",
        dragging ? "cursor-grabbing" : "cursor-grab",
      )}
    >
      <div
        className={cn(
          "absolute left-0 top-0 aspect-video w-full max-w-none",
          highlighted && "ring-2 ring-foreground",
        )}
        style={{
          transform: `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.scale})`,
          transformOrigin: "0 0",
          willChange: "transform",
        }}
      >
        {slide?.renderUrl ? (
          <img
            src={backendAssetUrl(slide.renderUrl)}
            alt={`${title} ${version}`}
            draggable={false}
            className="h-full w-full rounded-sm object-contain shadow-sm"
          />
        ) : (
          <div className="h-full w-full rounded-sm border bg-card p-10 shadow-sm">
            <div className="w-fit max-w-full rounded-md px-2 py-1 text-3xl font-bold tracking-normal">
              {slide?.title ?? "Rendered slide"}
            </div>
            <div className="mt-5 h-2 w-3/5 rounded bg-muted-foreground/40" />
            <div className="mt-8 grid grid-cols-3 gap-4">
              <div className="h-24 rounded-md border bg-muted/40" />
              <div className="h-24 rounded-md border bg-muted/60" />
              <div className="h-24 rounded-md border bg-muted" />
            </div>
            <div className="mt-6 text-sm text-muted-foreground">
              {slide?.subtitle ?? "Backend render unavailable"}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ----- AgentPanel (narration + chips) -----

function AgentPanel({
  panel,
  threads,
  activeThreadId,
  threadControlsDisabled,
  prompt,
  composerEnabled,
  composerPlaceholder,
  onCreateThread,
  onSelectThread,
  onPromptChange,
  onSubmitPrompt,
  onChipResponse,
  onClose,
}: {
  panel: PanelItem[];
  threads: ThreadSummary[];
  activeThreadId: string | null;
  threadControlsDisabled: boolean;
  prompt: string;
  composerEnabled: boolean;
  composerPlaceholder: string;
  onCreateThread: () => void;
  onSelectThread: (threadId: string) => void;
  onPromptChange: (value: string) => void;
  onSubmitPrompt: () => void;
  onChipResponse: (response: ChipResponse) => void;
  onClose: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const activeThread = threads.find((thread) => thread.threadId === activeThreadId);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [panel]);

  return (
    <aside className="relative flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={threadControlsDisabled || threads.length === 0}
              className="min-w-0 flex-1 justify-start px-2"
            >
              <MessageSquare className="size-3.5 shrink-0" />
              <span className="truncate text-xs font-medium">
                {activeThread?.title ?? "New context"}
              </span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            <DropdownMenuLabel>Threads</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {threads.map((thread) => (
              <DropdownMenuItem
                key={thread.threadId}
                onClick={() => onSelectThread(thread.threadId)}
                disabled={threadControlsDisabled}
              >
                <MessageSquare className="size-3.5" />
                <span className="min-w-0 flex-1 truncate">{thread.title}</span>
                <span className="text-xs text-muted-foreground">
                  {thread.messageCount}
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={onCreateThread}
              disabled={threadControlsDisabled}
              aria-label="Start new thread"
              className="text-muted-foreground hover:text-foreground"
            >
              <Plus className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>New thread</TooltipContent>
        </Tooltip>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onClose}
          aria-label="Close agent panel"
          className="text-muted-foreground hover:text-foreground"
        >
          <X className="size-3.5" />
        </Button>
      </div>
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <div className="space-y-3 px-4 py-4">
          {panel.map((item) => (
            <PanelTurn
              key={item.itemId}
              item={item}
              onChipResponse={onChipResponse}
            />
          ))}
          <div ref={bottomRef} />
        </div>
      </div>
      <Composer
        prompt={prompt}
        disabled={!composerEnabled}
        placeholder={composerPlaceholder}
        onPromptChange={onPromptChange}
        onSubmitPrompt={onSubmitPrompt}
      />
    </aside>
  );
}

function PanelTurn({
  item,
  onChipResponse,
}: {
  item: PanelItem;
  onChipResponse: (response: ChipResponse) => void;
}) {
  if (item.kind === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md border bg-muted px-3.5 py-2 text-sm leading-5 text-foreground shadow-sm">
          {item.text}
        </div>
      </div>
    );
  }
  if (item.kind === "prose") {
    return (
      <p className="text-sm leading-6 text-foreground">
        {item.text}
        {item.streaming ? (
          <span className="ml-0.5 inline-block h-3.5 w-1.5 -mb-0.5 animate-pulse bg-foreground" />
        ) : null}
      </p>
    );
  }
  if (item.kind === "reasoning") {
    return <ReasoningTurn item={item} />;
  }
  if (item.kind === "assistant_summary") {
    return <AssistantSummaryTurn item={item} />;
  }
  if (item.kind !== "chip") {
    return null;
  }
  return <ToolChipCard chip={item.chip} onChipResponse={onChipResponse} />;
}

function ReasoningTurn({ item }: { item: Extract<PanelItem, { kind: "reasoning" }> }) {
  return (
    <div className="space-y-1.5 pt-1">
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Brain className="size-3.5" />
        <span>{item.title ?? "Reasoning"}</span>
      </div>
      <div className="space-y-1.5 border-l border-border/70 ps-4">
        {item.events.map((event) => (
          <div
            key={event.itemId}
            className={cn(
              "flex items-start gap-2 text-xs",
              event.status === "failed" ? "text-destructive" : "text-muted-foreground",
            )}
          >
            <span
              className={cn(
                "mt-1.5 size-1.5 shrink-0 rounded-full",
                event.status === "running" && "bg-foreground animate-pulse",
                event.status === "done" && "bg-muted-foreground/70",
                event.status === "failed" && "bg-destructive",
              )}
            />
            <span className="min-w-0 break-words">{event.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function AssistantSummaryTurn({
  item,
}: {
  item: Extract<PanelItem, { kind: "assistant_summary" }>;
}) {
  return (
    <AssistantMessageShell>
      <p className="leading-6 text-foreground">{item.text}</p>
    </AssistantMessageShell>
  );
}

function AssistantMessageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="max-w-[92%] space-y-2 text-sm">
      {children}
    </div>
  );
}

function ToolChipCard({
  chip,
  onChipResponse,
}: {
  chip: ToolChip;
  onChipResponse: (response: ChipResponse) => void;
}) {
  const Icon = ICONS[chip.icon] ?? MoveRight;
  const isRunning = chip.status === "running";
  const isAwaiting = chip.status === "awaiting_input";
  const isSubmitting = chip.status === "submitting";
  const isFailed = chip.status === "failed";

  return (
    <AssistantMessageShell>
      <div
        className={cn(
          "flex items-start gap-2.5 text-sm",
          chip.status === "done" && "text-muted-foreground",
          isFailed && "text-destructive",
        )}
      >
        <span
          className={cn(
            "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground",
            isRunning && "animate-pulse",
            isAwaiting && "text-foreground",
            chip.status === "done" && "text-foreground",
            isFailed && "text-destructive",
          )}
        >
          <Icon className="size-3" />
        </span>
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <div className="text-sm font-medium leading-5 text-foreground">
              {chip.title}
            </div>
            {isSubmitting ? (
              <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
            ) : null}
          </div>
          {chip.subtitle ? (
            <div className="text-xs text-muted-foreground">{chip.subtitle}</div>
          ) : null}
          {chip.body ? <ChipBody body={chip.body} compact={chip.status === "done"} /> : null}
          {isAwaiting && chip.input ? (
            <ChipInputControls chip={chip} onChipResponse={onChipResponse} />
          ) : null}
          {isFailed && chip.failure ? (
            <ChipFailureControls chip={chip} onChipResponse={onChipResponse} />
          ) : null}
        </div>
      </div>
    </AssistantMessageShell>
  );
}

function ChipBody({
  body,
  compact = false,
}: {
  body: NonNullable<ToolChip["body"]>;
  compact?: boolean;
}) {
  const shellClass = cn(
    "grid gap-1 border-l border-border/70 ps-3 text-xs",
    compact && "opacity-80",
  );
  if (body.kind === "text_diff") {
    return (
      <div className={shellClass}>
        <div className="text-muted-foreground">
          <span className="font-mono">−</span>&nbsp;&nbsp;{body.before}
        </div>
        <div className="font-medium">
          <span className="font-mono">+</span>&nbsp;&nbsp;{body.after}
        </div>
        {body.flags.length ? (
          <div className="mt-1 text-[10px] uppercase tracking-wide text-muted-foreground">
            {body.flags.join(" · ")}
          </div>
        ) : null}
      </div>
    );
  }
  if (body.kind === "operation_list") {
    return (
      <div className={shellClass}>
        {body.operations.map((operation) => (
          <div key={`${operation.operationType}-${operation.targetRef}`} className="grid gap-0.5">
            <div className="font-medium">{operation.label}</div>
            <div className="text-muted-foreground">
              {operation.property ? `${operation.property}: ` : ""}
              <span className="font-mono">{operation.before}</span>
              <span className="px-1">-&gt;</span>
              <span className="font-mono text-foreground">{operation.after}</span>
            </div>
          </div>
        ))}
      </div>
    );
  }
  if (body.kind === "validation") {
    return (
      <div className={shellClass}>
        <KV label="changed" value={String(body.changed)} />
        <KV label="blocking" value={String(body.blocking)} />
        <KV
          label="warnings"
          value={
            body.warningText
              ? `${body.warnings} · ${body.warningText}`
              : String(body.warnings)
          }
        />
      </div>
    );
  }
  if (body.kind === "render_summary") {
    return (
      <div className="border-l border-border/70 ps-3 text-xs text-muted-foreground">
        slides: {body.affectedSlides.join(" · ")}
      </div>
    );
  }
  return (
    <div className="border-l border-border/70 ps-3 text-xs text-muted-foreground">
      target: <span className="font-mono">{body.targetRef}</span>
      &nbsp;·&nbsp;conf {(body.confidence * 100).toFixed(0)}%
    </div>
  );
}

function KV({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}

function ChipInputControls({
  chip,
  onChipResponse,
}: {
  chip: ToolChip;
  onChipResponse: (response: ChipResponse) => void;
}) {
  const [text, setText] = useState("");
  const input = chip.input;
  if (!input) return null;

  if (input.mode === "yes_no") {
    return (
      <div className="mt-2 flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          className="min-w-24"
          onClick={() =>
            onChipResponse({
              chipId: chip.chipId,
              verb: chip.verb,
              selectedId: input.secondary.id,
            })
          }
        >
          {input.secondary.label}
        </Button>
        <Button
          size="sm"
          className="min-w-24"
          onClick={() =>
            onChipResponse({
              chipId: chip.chipId,
              verb: chip.verb,
              selectedId: input.primary.id,
            })
          }
        >
          {input.primary.label}
          <span className="ml-1 text-[10px] opacity-70">⏎</span>
        </Button>
      </div>
    );
  }

  if (input.mode === "single_choice") {
    return (
      <div className="mt-2 flex flex-wrap gap-1.5">
        {input.options.map((opt) => (
          <button
            key={opt.id}
            type="button"
            onClick={() =>
              onChipResponse({
                chipId: chip.chipId,
                verb: chip.verb,
                selectedId: opt.id,
              })
            }
            className="max-w-full rounded-md border bg-background px-3 py-2 text-left text-sm transition hover:bg-muted"
          >
            <span className="block font-medium">{opt.label}</span>
            {opt.description ? (
              <span className="mt-0.5 block text-xs text-muted-foreground">
                {opt.description}
              </span>
            ) : null}
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="mt-2 grid gap-2">
      <Textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            if (text.trim()) {
              onChipResponse({
                chipId: chip.chipId,
                verb: chip.verb,
                answerText: text.trim(),
              });
            }
          }
        }}
        placeholder={input.placeholder}
        className="min-h-12 text-sm"
      />
      <div className="flex justify-end">
        <Button
          size="sm"
          disabled={!text.trim()}
          onClick={() =>
            onChipResponse({
              chipId: chip.chipId,
              verb: chip.verb,
              answerText: text.trim(),
            })
          }
        >
          Submit answer
        </Button>
      </div>
    </div>
  );
}

function ChipFailureControls({
  chip,
  onChipResponse,
}: {
  chip: ToolChip;
  onChipResponse: (response: ChipResponse) => void;
}) {
  if (!chip.failure) return null;
  return (
    <div className="grid gap-2">
      <div className="text-xs text-muted-foreground">
        {chip.failure.message}
      </div>
      {chip.failure.recovery.length ? (
        <div className="flex flex-wrap gap-1.5">
          {chip.failure.recovery.map((opt) => (
            <Button
              key={opt.id}
              variant="outline"
              size="sm"
              onClick={() =>
                onChipResponse({
                  chipId: chip.chipId,
                  verb: chip.verb,
                  selectedId: opt.id,
                })
              }
            >
              {opt.label}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Composer({
  prompt,
  disabled,
  placeholder,
  onPromptChange,
  onSubmitPrompt,
}: {
  prompt: string;
  disabled: boolean;
  placeholder: string;
  onPromptChange: (value: string) => void;
  onSubmitPrompt: () => void;
}) {
  return (
    <div className="border-t bg-background p-3">
      <div
        className={cn(
          "relative flex items-end rounded-2xl border bg-muted/30 px-3 py-2 shadow-sm transition-opacity",
          disabled && "opacity-60",
        )}
      >
        <Textarea
          id="agent-prompt"
          name="agent-prompt"
          value={prompt}
          onChange={(event) => onPromptChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              if (!disabled) onSubmitPrompt();
            }
          }}
          placeholder={placeholder}
          className="min-h-9 max-h-32 resize-none border-0 bg-transparent px-0 py-1 pr-10 text-sm leading-6 shadow-none focus-visible:ring-0 disabled:bg-transparent dark:bg-transparent dark:disabled:bg-transparent"
          disabled={disabled}
        />
        <Button
          size="icon-sm"
          className="absolute bottom-2 right-2 rounded-full"
          onClick={onSubmitPrompt}
          disabled={disabled || !prompt.trim()}
        >
          <ArrowUp className="size-3.5" />
          <span className="sr-only">Send</span>
        </Button>
      </div>
    </div>
  );
}

// ----- TrustStrip (unchanged) -----

function TrustStrip({
  deck,
  mode,
  exported,
}: {
  deck: DeckStatus | null;
  mode: UiState;
  exported: boolean;
}) {
  if (!deck) return null;

  const exportText = exported
    ? "Export prepared"
    : deck.validationSummary.canExport &&
        (mode === "accepted" || mode === "review_ready")
      ? "Export ready"
      : "Export locked";

  return (
    <footer className="flex items-center justify-between bg-background px-4 text-xs">
      <div className="flex min-w-0 items-center gap-3">
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="outline" className="rounded-md">
              Original preserved
            </Badge>
          </TooltipTrigger>
          <TooltipContent>Backend keeps the uploaded PPTX immutable.</TooltipContent>
        </Tooltip>
        <span className="truncate">Active: {deck.activeVersionId}</span>
        <span className="truncate">Parent: {deck.parentVersionId ?? "none"}</span>
        <span>{deck.changedSlides.length} slides changed</span>
      </div>
      <div className="flex items-center gap-2">
        <Badge
          variant={deck.validationSummary.warningCount ? "outline" : "secondary"}
          className="rounded-md"
        >
          Warnings: {deck.validationSummary.warningCount}
        </Badge>
        <Badge variant="secondary" className="rounded-md">
          {exportText}
        </Badge>
      </div>
    </footer>
  );
}
