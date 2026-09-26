import { describe, expect, it } from "vitest";
import {
  PROJECT_STATE_MIGRATION_SQL,
  PROJECT_STATE_SCHEMA_VERSION,
} from "../src/schema.js";

describe("project-state schema definition", () => {
  it("exports correct schema version", () => {
    expect(PROJECT_STATE_SCHEMA_VERSION).toBe(1);
  });

  it("includes DDL for checkpoints, previews, evidence, and deployments", () => {
    expect(PROJECT_STATE_MIGRATION_SQL).toContain(
      "create table if not exists checkpoints"
    );
    expect(PROJECT_STATE_MIGRATION_SQL).toContain(
      "create table if not exists previews"
    );
    expect(PROJECT_STATE_MIGRATION_SQL).toContain(
      "create table if not exists evidence"
    );
    expect(PROJECT_STATE_MIGRATION_SQL).toContain(
      "create table if not exists deployments"
    );
    expect(PROJECT_STATE_MIGRATION_SQL).toContain("checkpoints_scope_idx");
    expect(PROJECT_STATE_MIGRATION_SQL).toContain("previews_scope_idx");
    expect(PROJECT_STATE_MIGRATION_SQL).toContain("evidence_scope_idx");
  });
});
