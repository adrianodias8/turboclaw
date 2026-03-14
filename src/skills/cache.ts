import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "fs";
import { join } from "path";
import type { SkillContent } from "./types";

/**
 * Local filesystem cache for discovered skills.
 * Skills are stored at <projectRoot>/skills/<name>/SKILL.md
 */
export interface SkillCache {
  /** Check if a skill is already cached */
  has(name: string): boolean;
  /** Get cached skill content */
  get(name: string): string | null;
  /** Store a skill in the cache */
  put(skill: SkillContent): void;
  /** List all cached skill directory names */
  list(): string[];
  /** Get the absolute path to the cache directory */
  dir(): string;
  /** Get absolute path to a specific skill directory */
  skillDir(name: string): string;
}

export function createSkillCache(projectRoot: string): SkillCache {
  const cacheDir = join(projectRoot, "skills");

  function ensureDir() {
    if (!existsSync(cacheDir)) {
      mkdirSync(cacheDir, { recursive: true });
    }
  }

  return {
    has(name: string): boolean {
      return existsSync(join(cacheDir, name, "SKILL.md"));
    },

    get(name: string): string | null {
      const path = join(cacheDir, name, "SKILL.md");
      if (!existsSync(path)) return null;
      return readFileSync(path, "utf-8");
    },

    put(skill: SkillContent): void {
      ensureDir();
      const skillDir = join(cacheDir, skill.name);
      if (!existsSync(skillDir)) {
        mkdirSync(skillDir, { recursive: true });
      }
      writeFileSync(join(skillDir, "SKILL.md"), skill.content);
    },

    list(): string[] {
      if (!existsSync(cacheDir)) return [];
      return readdirSync(cacheDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && existsSync(join(cacheDir, d.name, "SKILL.md")))
        .map((d) => d.name);
    },

    dir(): string {
      return cacheDir;
    },

    skillDir(name: string): string {
      return join(cacheDir, name);
    },
  };
}
