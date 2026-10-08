import fs from "fs";
import path from "path";
import type { ToolRegistry } from "../tools/index.js";

export interface SkillManifest {
  name: string;
  description: string;
  version: string;
  requires: string[];
  systemPrompt: string;
}

const FRONTMATTER_REGEX = /^---\n([\s\S]*?)\n---/;

export class SkillLoader {
  private skillsDir: string;
  private toolRegistry: ToolRegistry;
  private watcher: fs.FSWatcher | null = null;

  constructor(skillsDir: string, toolRegistry: ToolRegistry) {
    this.skillsDir = skillsDir;
    this.toolRegistry = toolRegistry;
  }

  loadAll(): SkillManifest[] {
    const manifests = this.readSkills();
    this.startWatcher();
    return manifests;
  }

  reload(): SkillManifest[] {
    console.info("[SkillLoader] Reloading skills...");
    return this.readSkills();
  }

  stopWatcher(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  private readSkills(): SkillManifest[] {
    const skillsMap = new Map<string, SkillManifest>();

    if (!fs.existsSync(this.skillsDir)) {
      console.warn(`[SkillLoader] Skills directory not found: ${this.skillsDir}`);
      return [];
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.skillsDir, { withFileTypes: true });
    } catch {
      console.warn(`[SkillLoader] Could not read skills directory: ${this.skillsDir}`);
      return [];
    }

    const dirs = entries
      .filter((e) => e.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const dir of dirs) {
      const skillMdPath = path.join(this.skillsDir, dir.name, "SKILL.md");
      if (!fs.existsSync(skillMdPath)) continue;

      let raw: string;
      try {
        raw = fs.readFileSync(skillMdPath, "utf-8");
      } catch {
        console.warn(`[SkillLoader] Could not read: ${skillMdPath}`);
        continue;
      }

      const frontmatter = this.parseFrontMatter(raw);
      if (!frontmatter || !frontmatter.name) {
        console.warn(`[SkillLoader] Skill '${dir.name}' has no YAML frontmatter or missing 'name', skipping.`);
        continue;
      }

      const systemPrompt = raw.replace(FRONTMATTER_REGEX, "").trim();

      const manifest: SkillManifest = {
        name: frontmatter.name,
        description: frontmatter.description || "",
        version: frontmatter.version || "0.0.0",
        requires: frontmatter.requires || [],
        systemPrompt,
      };

      if (skillsMap.has(manifest.name)) {
        console.warn(
          `[SkillLoader] Duplicate skill name '${manifest.name}' — using ${dir.name}, ignoring earlier.`
        );
      }

      skillsMap.set(manifest.name, manifest);

      for (const toolName of manifest.requires) {
        if (!this.toolRegistry.has(toolName)) {
          console.warn(
            `[SkillLoader] Skill '${manifest.name}' requires tool '${toolName}' which is not registered.`
          );
        }
      }
    }

    return Array.from(skillsMap.values());
  }

  private parseFrontMatter(raw: string): { name?: string; description?: string; version?: string; requires?: string[] } | null {
    const match = raw.match(FRONTMATTER_REGEX);
    if (!match) return null;

    const yamlBlock = match[1];
    const result: Record<string, unknown> = {};
    let currentKey: string | null = null;
    let currentArray: string[] = [];

    for (const line of yamlBlock.split("\n")) {
      const indentMatch = line.match(/^\s{2}(\w+):\s*(.*)/);
      if (indentMatch) {
        if (currentKey === "requires") {
          currentArray.push(indentMatch[2].trim());
        } else {
          result[indentMatch[1]] = indentMatch[2]?.trim() || "";
        }
        continue;
      }

      const listItem = line.match(/^\s*-\s*(.+)/);
      if (listItem && currentKey === "requires") {
        currentArray.push(listItem[1].trim());
        continue;
      }

      const keyVal = line.match(/^(\w+):\s*(.*)/);
      if (keyVal) {
        if (currentKey === "requires" && currentArray.length > 0) {
          result[currentKey] = currentArray;
          currentArray = [];
        }
        currentKey = keyVal[1];
        const val = keyVal[2]?.trim() || "";
        if (val) {
          result[currentKey] = val;
        } else {
          currentArray = [];
        }
      }
    }

    if (currentKey === "requires" && currentArray.length > 0) {
      result[currentKey] = currentArray;
    }

    return result;
  }

  private startWatcher(): void {
    try {
      this.watcher = fs.watch(this.skillsDir, { recursive: true }, (_eventType, filename) => {
        if (filename && (filename.endsWith(".md") || filename === "SKILL.md")) {
          this.reload();
        }
      });
    } catch {
      console.warn("[SkillLoader] Could not start file watcher for skills directory.");
    }
  }
}