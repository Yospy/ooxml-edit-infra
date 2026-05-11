"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowUp,
  Check,
  CircleDot,
  Cog,
  Download,
  FileUp,
  History,
  Image as ImageIcon,
  Loader2,
  MoveRight,
  Pencil,
  Sparkles,
  X,
} from "lucide-react";

import {
  backendAssetUrl,
  emptyProgress,
  exportVersion,
  getDeckStatus,
  pollJob,
  requestEdit,
  respondToDecision,
  uploadDeck,
  type ApplyJobResult,
} from "@/lib/backend-client";
import type {
  AgentEvent,
  ChipResponse,
  DeckStatus,
  PanelItem,
  ProcessingProgress,
  ReviewResult,
  Slide,
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

function panelReducer(state: PanelItem[], event: AgentEvent): PanelItem[] {
  switch (event.type) {
    case "user_message":
      return [
        ...state,
        { kind: "user", itemId: event.itemId, text: event.text },
      ];
    case "prose_start":
      return [
        ...state,
        {
          kind: "prose",
          itemId: event.itemId,
          text: "",
          streaming: true,
        },
      ];
    case "prose_chunk":
      return state.map((item) =>
        item.kind === "prose" && item.itemId === event.itemId
          ? { ...item, text: item.text + event.delta }
          : item,
      );
    case "prose_end":
      return state.map((item) =>
        item.kind === "prose" && item.itemId === event.itemId
          ? { ...item, streaming: false }
          : item,
      );
    case "tool_start": {
      const exists = state.some(
        (it) => it.kind === "chip" && it.chip.chipId === event.chip.chipId,
      );
      if (exists) {
        return state.map((it) =>
          it.kind === "chip" && it.chip.chipId === event.chip.chipId
            ? { ...it, chip: event.chip }
            : it,
        );
      }
      return [
        ...state,
        { kind: "chip", itemId: event.chip.chipId, chip: event.chip },
      ];
    }
    case "tool_update":
    case "tool_complete":
      return state.map((it) =>
        it.kind === "chip" && it.chip.chipId === event.chipId
          ? { ...it, chip: { ...it.chip, ...event.patch } }
          : it,
      );
    case "tool_failed":
      return state.map((it) =>
        it.kind === "chip" && it.chip.chipId === event.chipId
          ? {
              ...it,
              chip: {
                ...it.chip,
                status: "failed",
                icon: "warning",
                input: undefined,
                failure: event.failure,
              },
            }
          : it,
      );
    case "decision_required":
      return state.map((it) =>
        it.kind === "chip" && it.chip.chipId === event.chipId
          ? {
              ...it,
              chip: {
                ...it.chip,
                status: "awaiting_input",
                input: event.input,
              },
            }
          : it,
      );
    case "decision_resolved":
      return state.map((it) =>
        it.kind === "chip" && it.chip.chipId === event.chipId
          ? { ...it, chip: { ...it.chip, status: "submitting" } }
          : it,
      );
    case "banner":
      return state;
    default:
      return state;
  }
}

export default function Home() {
  const [mode, setMode] = useState<UiState>("upload_empty");
  const [deck, setDeck] = useState<DeckStatus | null>(null);
  const [selectedSlideId, setSelectedSlideId] = useState("slide_3");
  const [progress, setProgress] = useState<ProcessingProgress>(emptyProgress);
  const [prompt, setPrompt] = useState("");
  const [lastPrompt, setLastPrompt] = useState("");
  const [exported, setExported] = useState(false);
  const [reviewResult, setReviewResult] = useState<ReviewResult | null>(null);
  const [panel, setPanel] = useState<PanelItem[]>([]);
  const [panelOpen, setPanelOpen] = useState(true);

  const dispatchEvents = useCallback((events?: AgentEvent[]) => {
    if (!events?.length) return;
    setPanel((prev) =>
      events.reduce(
        (next, event) =>
          event.type === "banner" ? next : panelReducer(next, event),
        prev,
      ),
    );
  }, []);

  const clearPanel = useCallback(() => {
    setPanel([]);
  }, []);

  const selectedSlide = useMemo(
    () => deck?.slides.find((slide) => slide.slideId === selectedSlideId),
    [deck, selectedSlideId],
  );

  const hasBlockingChip = useMemo(
    () =>
      panel.some(
        (it) =>
          it.kind === "chip" &&
          (it.chip.status === "awaiting_input" ||
            it.chip.status === "submitting" ||
            it.chip.status === "running"),
      ),
    [panel],
  );

  const composerEnabled = mode === "ready" && !hasBlockingChip;

  function jumpToWorkspace() {
    void startUpload();
  }

  async function startUpload(file?: File) {
    try {
      clearPanel();
      setPrompt("");
      setLastPrompt("");
      setExported(false);
      setReviewResult(null);
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
      setDeck(readyDeck);
      setSelectedSlideId(
        readyDeck.slides.find((slide) => slide.slideId === "slide_3")
          ?.slideId ??
          readyDeck.slides[0]?.slideId ??
          "slide_1",
      );
      setMode("ready");
    } catch (error) {
      console.error(error);
      setMode("upload_empty");
    }
  }

  async function submitPrompt() {
    if (!deck || !prompt.trim() || !composerEnabled) return;
    const message = prompt.trim();
    setLastPrompt(message);
    setPrompt("");
    clearPanel();
    setReviewResult(null);
    setMode("planning");

    try {
      const result = await requestEdit({
        deckId: deck.deckId,
        versionId: deck.activeVersionId,
        slideId: selectedSlideId,
        selectedElementIds: [],
        message,
      });
      dispatchEvents(result.events);
      setMode("awaiting_plan_approval");
    } catch (error) {
      console.error(error);
      setMode("ready");
    }
  }

  async function onChipResponse(response: ChipResponse) {
    if (!deck) return;
    try {
      const result = await respondToDecision(deck.deckId, response.chipId, {
        versionId: deck.activeVersionId,
        selectedOptionId: response.selectedId,
        answerText: response.answerText,
      });
      dispatchEvents(result.events);

      if (result.jobId) {
        setMode(result.uiState);
        const job = await pollJob<ApplyJobResult>(result.jobId);
        if (job.result?.events) dispatchEvents(job.result.events);
        if (job.result?.deckStatus) setDeck(job.result.deckStatus);
        if (job.result?.reviewResult) {
          setReviewResult(job.result.reviewResult);
          setMode("review_ready");
        }
        return;
      }

      if (result.deckStatus) setDeck(result.deckStatus);
      if (response.verb === "apply_plan" && response.selectedId !== "apply") {
        setPrompt(lastPrompt);
      }
      if (response.verb === "accept_version" && response.selectedId === "reject") {
        setExported(false);
        setReviewResult(null);
      }
      if (response.verb === "accept_version" && response.selectedId === "refine") {
        setExported(false);
        setReviewResult(null);
      }
      setMode(result.uiState);
    } catch (error) {
      console.error(error);
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
            />
            {panelOpen ? (
              <div className="min-h-0 p-3 pl-0">
                <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border bg-background shadow-xl">
                  <AgentPanel
                    panel={panel}
                    prompt={prompt}
                    composerEnabled={composerEnabled}
                    composerPlaceholder={composerPlaceholder(mode, hasBlockingChip)}
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
  if (mode === "ready" && !hasBlockingChip) return "Describe an edit...";
  if (mode === "accepted") return "v2 accepted · edit cycle complete.";
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
}: {
  mode: UiState;
  slide?: Slide;
  activeVersionId: string;
  reviewResult: ReviewResult | null;
}) {
  const reviewMode = mode === "review_ready" || mode === "accepted";
  const highlighted = mode === "awaiting_plan_approval";
  const reviewPreview =
    reviewResult?.slidePreviews.find(
      (preview) => preview.slideId === slide?.slideId,
    ) ?? reviewResult?.slidePreviews[0];
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
    slide && reviewPreview
      ? {
          ...slide,
          title: reviewPreview.after.title,
          subtitle: reviewPreview.after.subtitle,
          renderUrl: reviewPreview.after.renderUrl,
        }
      : slide;

  return (
    <section className="min-w-0 bg-muted/40">
      <div className="flex h-12 items-center justify-between border-b bg-background px-5">
        <div>
          <div className="text-sm font-semibold">
            {reviewMode ? "Rendered before / after" : "Rendered slide"}
          </div>
          <div className="text-xs text-muted-foreground">
            {reviewMode
              ? "Result appears only after approval and backend rendering."
              : "Current backend render. No mutation before approval."}
          </div>
        </div>
        <Badge variant="outline" className="rounded-md">
          {slide ? `Slide ${slide.number}` : "No slide"}
        </Badge>
      </div>
      <div className="flex h-[calc(100%-48px)] items-center justify-center p-8">
        {reviewMode ? (
          <div className="grid w-full max-w-[1120px] grid-cols-2 gap-5">
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
              slide={afterSlide}
              version={
                reviewPreview?.after.versionId ??
                reviewResult?.outputVersionId ??
                activeVersionId
              }
              changed
            />
          </div>
        ) : (
          <div className="w-full max-w-[860px]">
            <SlideRender
              title="Current render"
              slide={slide}
              version={activeVersionId}
              highlighted={highlighted}
            />
          </div>
        )}
      </div>
    </section>
  );
}

function SlideRender({
  title,
  slide,
  version,
  highlighted,
  changed,
}: {
  title: string;
  slide?: Slide;
  version: string;
  highlighted?: boolean;
  changed?: boolean;
}) {
  return (
    <Card className="rounded-lg border bg-card p-0 shadow-none">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div className="text-sm font-semibold">{title}</div>
        <Badge variant={changed ? "secondary" : "outline"} className="rounded-md">
          {version}
        </Badge>
      </div>
      <div className="p-5">
        <div className="aspect-video rounded-lg border bg-background p-8 shadow-sm">
          {slide?.renderUrl ? (
            <img
              src={backendAssetUrl(slide.renderUrl)}
              alt={`${title} ${version}`}
              className={cn(
                "h-full w-full rounded-md object-contain",
                highlighted && "ring-2 ring-foreground",
              )}
            />
          ) : (
            <>
              <div
                className={cn(
                  "w-fit max-w-full rounded-md px-2 py-1 text-3xl font-bold tracking-normal",
                  highlighted && "ring-2 ring-foreground",
                )}
              >
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
            </>
          )}
        </div>
      </div>
    </Card>
  );
}

// ----- AgentPanel (narration + chips) -----

function AgentPanel({
  panel,
  prompt,
  composerEnabled,
  composerPlaceholder,
  onPromptChange,
  onSubmitPrompt,
  onChipResponse,
  onClose,
}: {
  panel: PanelItem[];
  prompt: string;
  composerEnabled: boolean;
  composerPlaceholder: string;
  onPromptChange: (value: string) => void;
  onSubmitPrompt: () => void;
  onChipResponse: (response: ChipResponse) => void;
  onClose: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [panel]);

  return (
    <aside className="relative flex h-full min-h-0 flex-col bg-background">
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={onClose}
        aria-label="Close agent panel"
        className="absolute right-2 top-2 z-10 text-muted-foreground hover:text-foreground"
      >
        <X className="size-3.5" />
      </Button>
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <div className="space-y-3 px-4 pb-4 pt-10">
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
  return <ToolChipCard chip={item.chip} onChipResponse={onChipResponse} />;
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
    <div
      className={cn(
        "rounded-lg border bg-card px-3 py-2.5 text-sm shadow-sm transition-colors",
        isAwaiting && "border-foreground/30",
        isFailed && "border-destructive/40 bg-destructive/[0.02]",
      )}
    >
      <div className="flex items-start gap-2.5">
        <span
          className={cn(
            "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md border bg-background text-muted-foreground",
            isRunning && "animate-pulse",
            isAwaiting && "text-foreground",
            chip.status === "done" && "text-foreground",
            isFailed && "border-destructive/40 text-destructive",
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
          {chip.body ? <ChipBody body={chip.body} /> : null}
          {isAwaiting && chip.input ? (
            <ChipInputControls chip={chip} onChipResponse={onChipResponse} />
          ) : null}
          {isFailed && chip.failure ? (
            <ChipFailureControls chip={chip} onChipResponse={onChipResponse} />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ChipBody({ body }: { body: NonNullable<ToolChip["body"]> }) {
  if (body.kind === "text_diff") {
    return (
      <div className="grid gap-1 rounded-md border bg-muted/40 px-3 py-2 text-xs">
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
  if (body.kind === "validation") {
    return (
      <div className="grid gap-1 rounded-md border bg-muted/40 px-3 py-2 text-xs">
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
      <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        slides: {body.affectedSlides.join(" · ")}
      </div>
    );
  }
  return (
    <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
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
      <div className="mt-2 flex gap-2">
        <Button
          variant="outline"
          size="sm"
          className="flex-1"
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
          className="flex-1"
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
      <div className="mt-2 grid gap-1.5">
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
            className="rounded-md border bg-background px-3 py-2 text-left text-sm transition hover:bg-muted"
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
