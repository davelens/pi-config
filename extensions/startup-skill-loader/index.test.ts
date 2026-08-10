import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildStartupContext } from "./index.ts";

test("loads list and legacy startup skill declarations", () => {
  const cwd = mkdtempSync(join(tmpdir(), "startup-skills-"));
  const skillPath = join(cwd, "caveman.md");
  writeFileSync(skillPath, "Caveman instructions");
  mkdirSync(join(cwd, "docs", "memory"), { recursive: true });
  writeFileSync(join(cwd, "docs", "memory", "index.md"), "Project memory");

  const context = buildStartupContext({
    cwd,
    contextFiles: [{
      path: join(cwd, "AGENTS.md"),
      content: [
        "Load skills:",
        "- caveman",
        "- project-wiki if `./docs/wiki` exists",
        "- Load `project-memory` skill",
      ].join("\n"),
    }],
    skills: [
      { name: "caveman", filePath: skillPath },
      { name: "project-memory", filePath: skillPath },
    ] as never,
  });

  assert.match(context ?? "", /name="caveman" status="loaded"/);
  assert.match(context ?? "", /name="project-wiki" status="skipped"/);
  assert.match(context ?? "", /name="project-memory" status="loaded"/);
  assert.match(context ?? "", /<project_memory[^>]+>\nProject memory/);
});
