import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type AppConfig = {
  dataDir: string;
  databasePath: string;
  proprietaryDataDir: string;
  openaiApiKey?: string;
  openaiModel: string;
};

const __dirname = dirname(fileURLToPath(import.meta.url));

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  loadDotEnv();
  const dataDir =
    overrides.dataDir ??
    process.env.DATA_DIR ??
    resolve(__dirname, "..", "data");

  return {
    dataDir,
    databasePath: overrides.databasePath ?? resolve(dataDir, "app.db"),
    proprietaryDataDir:
      overrides.proprietaryDataDir ?? resolve(__dirname, "..", "..", "data"),
    openaiApiKey: overrides.openaiApiKey ?? process.env.OPENAI_API_KEY,
    openaiModel: overrides.openaiModel ?? process.env.OPENAI_MODEL ?? "gpt-5.5",
  };
}

function loadDotEnv(): void {
  for (const path of candidateEnvPaths()) {
    if (!existsSync(path)) continue;
    const content = readFileSync(path, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 1) continue;
      const key = trimmed.slice(0, eq).trim();
      const raw = trimmed.slice(eq + 1).trim();
      if (process.env[key] !== undefined) continue;
      process.env[key] = stripQuotes(raw);
    }
  }
}

function candidateEnvPaths(): string[] {
  return [
    resolve(process.cwd(), ".env"),
    resolve(process.cwd(), "..", ".env"),
    resolve(__dirname, "..", "..", ".env"),
  ];
}

function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
