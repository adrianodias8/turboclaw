import { searchByFullText, searchByTag } from "./search";
import { listNotes } from "./vault";
import type { SearchResult } from "./types";
import { join } from "path";
import { existsSync, readFileSync, readdirSync } from "fs";

const MAX_CORE_CHARS = 20000;

export function buildCoreContext(vaultPath: string): string {
  const coreNotes = listNotes(vaultPath, "core");
  if (coreNotes.length === 0) return "";

  const sections = coreNotes.map((note) => {
    const title = note.frontmatter.title ?? "Untitled";
    return `## ${title}\n\n${note.content}`;
  });

  let result = `# Core Memory\n\n${sections.join("\n\n")}`;

  if (result.length > MAX_CORE_CHARS) {
    // Truncate individual note contents while keeping titles
    const truncatedSections: string[] = [];
    let remaining = MAX_CORE_CHARS - "# Core Memory\n\n".length - "\n\n[Core memory truncated — reduce number of core notes]".length;

    for (const note of coreNotes) {
      const title = note.frontmatter.title ?? "Untitled";
      const header = `## ${title}\n\n`;
      if (remaining <= header.length) break;
      remaining -= header.length;
      const contentBudget = Math.min(note.content.length, remaining);
      const content = note.content.slice(0, contentBudget);
      truncatedSections.push(`## ${title}\n\n${content}`);
      remaining -= contentBudget;
      if (remaining <= 0) break;
    }

    result = `# Core Memory\n\n${truncatedSections.join("\n\n")}\n\n[Core memory truncated — reduce number of core notes]`;
  }

  return result;
}

export function buildContext(
  vaultPath: string,
  query: string,
  tags: string[] = [],
  maxNotes: number = 5
): string {
  const results: SearchResult[] = [];

  // Search by full text
  if (query) {
    results.push(...searchByFullText(vaultPath, query));
  }

  // Search by tags
  for (const tag of tags) {
    results.push(...searchByTag(vaultPath, tag));
  }

  // Deduplicate by note path
  const seen = new Set<string>();
  const unique: SearchResult[] = [];
  for (const r of results) {
    if (!seen.has(r.note.path)) {
      seen.add(r.note.path);
      unique.push(r);
    }
  }

  // Sort by score and take top N
  unique.sort((a, b) => b.score - a.score);
  const top = unique.slice(0, maxNotes);

  if (top.length === 0) return "";

  const sections = top.map((r) => {
    const title = r.note.frontmatter.title ?? "Untitled";
    const tags = r.note.frontmatter.tags.length > 0
      ? ` [${r.note.frontmatter.tags.join(", ")}]`
      : "";
    return `## ${title}${tags}\n\n${r.note.content}`;
  });

  return `# Relevant Memory Notes\n\n${sections.join("\n\n---\n\n")}`;
}

/**
 * Build context from coding rules (docker/rules/).
 * Always injects common/ rules, plus language-specific rules if detected.
 */
export function buildRulesContext(rulesDir: string, languages: string[] = []): string {
  if (!existsSync(rulesDir)) return "";

  const sections: string[] = [];

  // Always inject common rules
  const commonDir = join(rulesDir, "common");
  if (existsSync(commonDir)) {
    for (const file of readdirSync(commonDir).filter(f => f.endsWith(".md")).sort()) {
      sections.push(readFileSync(join(commonDir, file), "utf-8").trim());
    }
  }

  // Inject language-specific rules
  for (const lang of languages) {
    const langDir = join(rulesDir, lang);
    if (existsSync(langDir)) {
      for (const file of readdirSync(langDir).filter(f => f.endsWith(".md")).sort()) {
        sections.push(readFileSync(join(langDir, file), "utf-8").trim());
      }
    }
  }

  if (sections.length === 0) return "";
  return `# Coding Rules\n\n${sections.join("\n\n---\n\n")}`;
}

/**
 * Build context from a role-specific skill (docker/skills/<role>/SKILL.md).
 */
export function buildRoleSkillContext(skillsDir: string, role: string): string {
  const skillPath = join(skillsDir, role, "SKILL.md");
  if (!existsSync(skillPath)) return "";
  const content = readFileSync(skillPath, "utf-8").trim();
  // Strip YAML frontmatter if present
  const stripped = content.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();
  return `# Agent Role: ${role}\n\n${stripped}`;
}

/**
 * Detect languages from workspace contents by checking for config files.
 */
export function detectLanguages(workspacePath: string): string[] {
  const languages: string[] = [];
  const checks: [string, string][] = [
    ["tsconfig.json", "typescript"],
    ["package.json", "typescript"],    // Bun/Node projects
    ["composer.json", "php"],
    ["go.mod", "golang"],
    ["Cargo.toml", "rust"],
    ["pyproject.toml", "python"],
    ["requirements.txt", "python"],
  ];
  for (const [file, lang] of checks) {
    if (existsSync(join(workspacePath, file)) && !languages.includes(lang)) {
      languages.push(lang);
    }
  }
  return languages;
}
