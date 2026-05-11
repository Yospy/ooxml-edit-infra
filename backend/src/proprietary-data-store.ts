import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { makeId } from "./ids.js";
import type { EditOperation, ValidationSummary } from "./types.js";
import type { GraphSlide } from "./repository.js";

export type FinalChangeDecision = "accepted" | "rejected";

export type RenderArtifactSnapshot = {
  slide_id: string;
  version_id: string;
  artifact_id?: string;
  path?: string;
  url?: string;
};

export type FinalChangeEventInput = {
  created_at: string;
  decision: FinalChangeDecision;
  deck_id: string;
  plan_id: string;
  decision_id: string;
  user_prompt: string;
  input_version_id: string;
  output_version_id: string;
  changed_slide_ids: string[];
  change_patch: EditOperation[];
  before_state: {
    version_id: string;
    slides: GraphSlide[];
  };
  after_state: {
    version_id: string;
    slides: GraphSlide[];
  };
  render_artifacts: {
    before: RenderArtifactSnapshot[];
    after: RenderArtifactSnapshot[];
  };
  validation_summary: ValidationSummary;
  provenance: {
    model_version: string;
    prompt_version: string;
  };
};

export type FinalChangeEvent = FinalChangeEventInput & {
  schema_version: 1;
  event_type: "final_change_event";
  event_id: string;
};

export class ProprietaryDataStore {
  constructor(private readonly dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
  }

  writeFinalChangeEvent(input: FinalChangeEventInput): {
    event: FinalChangeEvent;
    path: string;
  } {
    const event: FinalChangeEvent = {
      schema_version: 1,
      event_type: "final_change_event",
      event_id: makeId("fce"),
      ...input,
    };
    const date = input.created_at.slice(0, 10);
    const dir = resolve(this.dataDir, "final-change-events", date);
    mkdirSync(dir, { recursive: true });
    const path = resolve(dir, `${event.event_id}.json`);
    writeFileSync(path, `${JSON.stringify(event, null, 2)}\n`);
    return { event, path };
  }
}
