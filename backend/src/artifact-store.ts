import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";

export class ArtifactStore {
  constructor(readonly dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
  }

  presentationDir(presentationId: string): string {
    return resolve(
      this.dataDir,
      "projects",
      "project_local",
      "presentations",
      presentationId,
    );
  }

  originalPptxPath(presentationId: string): string {
    return resolve(this.presentationDir(presentationId), "original", "deck.pptx");
  }

  originalExtractedPath(presentationId: string): string {
    return resolve(this.presentationDir(presentationId), "original", "extracted");
  }

  versionDir(presentationId: string, versionId: string): string {
    return resolve(this.presentationDir(presentationId), "versions", versionId);
  }

  versionPptxPath(presentationId: string, versionId: string): string {
    return resolve(this.versionDir(presentationId, versionId), "deck.pptx");
  }

  versionExtractedPath(presentationId: string, versionId: string): string {
    return resolve(this.versionDir(presentationId, versionId), "extracted");
  }

  versionGraphPath(presentationId: string, versionId: string): string {
    return resolve(this.versionDir(presentationId, versionId), "graph.json");
  }

  renderPath(presentationId: string, versionId: string, slideId: string): string {
    return resolve(this.versionDir(presentationId, versionId), "renders", `${slideId}.svg`);
  }

  thumbnailPath(presentationId: string, versionId: string, slideId: string): string {
    return resolve(this.versionDir(presentationId, versionId), "renders", `${slideId}-thumb.svg`);
  }

  exportPath(presentationId: string, versionId: string, fileName: string): string {
    return resolve(this.presentationDir(presentationId), "exports", `${fileName}-${versionId}.pptx`);
  }

  writeOriginal(presentationId: string, bytes: Buffer): void {
    writeFileEnsured(this.originalPptxPath(presentationId), bytes);
  }

  createOriginalExtraction(presentationId: string): void {
    this.extractPptx(this.originalPptxPath(presentationId), this.originalExtractedPath(presentationId));
  }

  createInitialVersion(presentationId: string): void {
    const pptxPath = this.versionPptxPath(presentationId, "v1");
    writeFileEnsured(pptxPath, readFileSync(this.originalPptxPath(presentationId)));
    this.extractPptx(pptxPath, this.versionExtractedPath(presentationId, "v1"));
  }

  createVersionFromSource(
    presentationId: string,
    sourceVersionId: string,
    nextVersionId: string,
  ): void {
    const sourcePptx = this.versionPptxPath(presentationId, sourceVersionId);
    const sourceExtracted = this.versionExtractedPath(presentationId, sourceVersionId);
    const nextDir = this.versionDir(presentationId, nextVersionId);
    rmIfExists(nextDir);
    mkdirSync(nextDir, { recursive: true });
    copyFileSync(sourcePptx, this.versionPptxPath(presentationId, nextVersionId));
    cpSync(sourceExtracted, this.versionExtractedPath(presentationId, nextVersionId), {
      recursive: true,
    });
  }

  packageVersion(presentationId: string, versionId: string): void {
    const pptxPath = this.versionPptxPath(presentationId, versionId);
    rmIfExists(pptxPath);
    mkdirSync(dirname(pptxPath), { recursive: true });
    execFileSync("zip", ["-qr", pptxPath, "."], {
      cwd: this.versionExtractedPath(presentationId, versionId),
    });
  }

  writeJson(path: string, value: unknown): void {
    writeFileEnsured(path, `${JSON.stringify(value, null, 2)}\n`);
  }

  writeText(path: string, value: string): void {
    writeFileEnsured(path, value);
  }

  copyExport(presentationId: string, versionId: string, fileName: string): string {
    const target = this.exportPath(presentationId, versionId, fileName.replace(/\.pptx$/i, ""));
    writeFileEnsured(target, readFileSync(this.versionPptxPath(presentationId, versionId)));
    return target;
  }

  private extractPptx(pptxPath: string, extractedPath: string): void {
    rmIfExists(extractedPath);
    mkdirSync(extractedPath, { recursive: true });
    execFileSync("unzip", ["-qq", pptxPath, "-d", extractedPath]);
  }
}

function writeFileEnsured(path: string, value: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}

function rmIfExists(path: string): void {
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
}
