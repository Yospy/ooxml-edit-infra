import { randomUUID } from "node:crypto";

export function makeId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

export const DEFAULT_PROJECT_ID = "project_local";
export const DEFAULT_THREAD_TITLE = "Default edit thread";
