import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { EditPlan } from "./types.js";
import type { SQLiteRepository } from "./repository.js";
import { escapeXml } from "./xml.js";

export function applyTextOperations(input: {
  repo: SQLiteRepository;
  presentationId: string;
  sourceVersionId: string;
  extractedPath: string;
  plan: EditPlan;
}): string[] {
  const changedSlides = new Set<string>();
  for (const op of input.plan.operations) {
    if (op.operationType === "fit_text") continue;
    if (op.operationType !== "replace_text") {
      throw operationError("OPERATION_NOT_ALLOWED", `Unsupported operation: ${op.operationType}`);
    }
    const target = input.repo.getElementByTargetRef(
      input.presentationId,
      input.sourceVersionId,
      op.targetRef,
    );
    if (!target) {
      throw operationError("TARGET_NOT_FOUND", `Target not found: ${op.targetRef}`);
    }
    const partPath = resolve(input.extractedPath, target.xmlProvenance.part);
    const xml = readFileSync(partPath, "utf8");
    const next = replaceText(xml, op.before, op.after);
    if (next === xml) {
      throw operationError(
        "TARGET_NOT_FOUND",
        `Could not find text "${op.before}" in ${target.xmlProvenance.part}.`,
      );
    }
    writeFileSync(partPath, next);
    changedSlides.add(target.slideId);
  }
  return [...changedSlides];
}

function replaceText(xml: string, before: string, after: string): string {
  const escapedBefore = escapeXml(before);
  const escapedAfter = escapeXml(after);
  if (xml.includes(`<a:t>${escapedBefore}</a:t>`)) {
    return xml.replace(`<a:t>${escapedBefore}</a:t>`, `<a:t>${escapedAfter}</a:t>`);
  }
  return xml.replace(escapedBefore, escapedAfter);
}

function operationError(code: string, message: string) {
  const error = new Error(message) as Error & { statusCode: number; code: string };
  error.statusCode = 409;
  error.code = code;
  return error;
}
