import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type DbStatement = {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
};

export class AppDatabase {
  private readonly db: DatabaseSync;

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.migrate();
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  prepare(sql: string): DbStatement {
    return this.db.prepare(sql);
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS presentations (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        file_name TEXT NOT NULL,
        original_version_id TEXT NOT NULL,
        active_version_id TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(id)
      );

      CREATE TABLE IF NOT EXISTS presentation_versions (
        uid TEXT PRIMARY KEY,
        presentation_id TEXT NOT NULL,
        version_id TEXT NOT NULL,
        parent_version_id TEXT,
        version_number INTEGER NOT NULL,
        status TEXT NOT NULL,
        file_path TEXT NOT NULL,
        extracted_path TEXT NOT NULL,
        graph_path TEXT NOT NULL,
        created_by_plan_id TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(presentation_id, version_id),
        FOREIGN KEY(presentation_id) REFERENCES presentations(id)
      );

      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        presentation_id TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(presentation_id) REFERENCES presentations(id)
      );

      CREATE TABLE IF NOT EXISTS thread_messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(thread_id) REFERENCES threads(id)
      );

      CREATE TABLE IF NOT EXISTS edit_plans (
        id TEXT PRIMARY KEY,
        presentation_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        created_from_version_id TEXT NOT NULL,
        plan_type TEXT NOT NULL,
        status TEXT NOT NULL,
        user_prompt TEXT NOT NULL,
        summary TEXT NOT NULL,
        risks_json TEXT NOT NULL,
        affected_slides_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        approved_at TEXT,
        applied_at TEXT,
        FOREIGN KEY(presentation_id) REFERENCES presentations(id),
        FOREIGN KEY(thread_id) REFERENCES threads(id)
      );

      CREATE TABLE IF NOT EXISTS edit_operations (
        id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL,
        presentation_id TEXT NOT NULL,
        operation_type TEXT NOT NULL,
        target_ref TEXT NOT NULL,
        human_label TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        before_json TEXT NOT NULL,
        after_json TEXT NOT NULL,
        preserve_style INTEGER NOT NULL,
        preserve_bounds INTEGER NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(plan_id) REFERENCES edit_plans(id),
        FOREIGN KEY(presentation_id) REFERENCES presentations(id)
      );

      CREATE TABLE IF NOT EXISTS decisions (
        id TEXT PRIMARY KEY,
        presentation_id TEXT NOT NULL,
        version_id TEXT NOT NULL,
        plan_id TEXT,
        thread_id TEXT,
        purpose TEXT NOT NULL DEFAULT 'clarify_intent',
        source_version_id TEXT,
        subject_version_id TEXT,
        kind TEXT NOT NULL,
        action TEXT NOT NULL,
        status TEXT NOT NULL,
        title TEXT NOT NULL,
        question TEXT NOT NULL,
        context TEXT,
        input_mode TEXT NOT NULL,
        options_json TEXT NOT NULL,
        default_option_id TEXT,
        answer_json TEXT,
        created_at TEXT NOT NULL,
        answered_at TEXT,
        FOREIGN KEY(presentation_id) REFERENCES presentations(id)
      );

      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        presentation_id TEXT,
        version_id TEXT,
        job_type TEXT NOT NULL,
        status TEXT NOT NULL,
        progress_json TEXT NOT NULL,
        result_json TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      );

      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        presentation_id TEXT NOT NULL,
        version_id TEXT,
        type TEXT NOT NULL,
        path TEXT NOT NULL,
        content_type TEXT NOT NULL,
        slide_id TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(presentation_id) REFERENCES presentations(id)
      );

      CREATE TABLE IF NOT EXISTS slides (
        uid TEXT PRIMARY KEY,
        presentation_id TEXT NOT NULL,
        version_id TEXT NOT NULL,
        slide_index INTEGER NOT NULL,
        slide_id TEXT NOT NULL,
        title TEXT NOT NULL,
        subtitle TEXT NOT NULL,
        status TEXT NOT NULL,
        width_emu INTEGER NOT NULL,
        height_emu INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(presentation_id, version_id, slide_id),
        FOREIGN KEY(presentation_id) REFERENCES presentations(id)
      );

      CREATE TABLE IF NOT EXISTS slide_elements (
        uid TEXT PRIMARY KEY,
        presentation_id TEXT NOT NULL,
        version_id TEXT NOT NULL,
        slide_id TEXT NOT NULL,
        element_id TEXT NOT NULL,
        element_type TEXT NOT NULL,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        bounds_json TEXT NOT NULL,
        style_json TEXT NOT NULL,
        xml_provenance_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(presentation_id, version_id, slide_id, element_id),
        FOREIGN KEY(presentation_id) REFERENCES presentations(id)
      );

      CREATE TABLE IF NOT EXISTS validation_results (
        id TEXT PRIMARY KEY,
        presentation_id TEXT NOT NULL,
        version_id TEXT NOT NULL,
        slide_id TEXT,
        issue_type TEXT NOT NULL,
        severity TEXT NOT NULL,
        message TEXT NOT NULL,
        target_ref TEXT,
        details_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(presentation_id) REFERENCES presentations(id)
      );

      CREATE TABLE IF NOT EXISTS exports (
        id TEXT PRIMARY KEY,
        presentation_id TEXT NOT NULL,
        version_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        artifact_id TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(presentation_id) REFERENCES presentations(id)
      );
    `);
    this.addColumnIfMissing(
      "decisions",
      "purpose",
      "TEXT NOT NULL DEFAULT 'clarify_intent'",
    );
    this.addColumnIfMissing("decisions", "source_version_id", "TEXT");
    this.addColumnIfMissing("decisions", "subject_version_id", "TEXT");
  }

  private addColumnIfMissing(table: string, column: string, definition: string): void {
    const columns = this.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
    }>;
    if (columns.some((candidate) => candidate.name === column)) return;
    this.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
  }
}
