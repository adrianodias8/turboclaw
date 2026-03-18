import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from "fs";
import { join, dirname } from "path";
import { parseFrontmatter } from "../memory/vault";

export interface SkillValidation {
  valid: boolean;
  errors: string[];
}

export interface SkillManageResult {
  ok: boolean;
  error?: string;
  path?: string;
}

const SKILL_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_DESCRIPTION_LENGTH = 1024;

/** Validate skill name: lowercase alphanumeric, hyphens, dots, underscores; max 64 chars */
export function validateSkillName(name: string): SkillValidation {
  const errors: string[] = [];
  if (!name) {
    errors.push("Skill name is required");
  } else if (!SKILL_NAME_RE.test(name)) {
    if (name.length > 64) {
      errors.push("Skill name must be at most 64 characters");
    }
    if (/[A-Z]/.test(name)) {
      errors.push("Skill name must be lowercase");
    }
    if (/[^a-z0-9._-]/.test(name)) {
      errors.push("Skill name may only contain lowercase alphanumeric characters, hyphens, dots, and underscores");
    }
    if (/^[^a-z0-9]/.test(name)) {
      errors.push("Skill name must start with a lowercase letter or digit");
    }
  }
  return { valid: errors.length === 0, errors };
}

/** Validate SKILL.md content: must have YAML frontmatter with name + description, must have body */
export function validateSkillContent(content: string): SkillValidation {
  const errors: string[] = [];

  if (!content.startsWith("---")) {
    errors.push("Content must start with YAML frontmatter (---)");
    return { valid: false, errors };
  }

  const { frontmatter, content: body } = parseFrontmatter(content);

  if (!frontmatter.name || typeof frontmatter.name !== "string") {
    errors.push("Frontmatter must contain a 'name' field");
  }

  if (!frontmatter.description || typeof frontmatter.description !== "string") {
    errors.push("Frontmatter must contain a 'description' field");
  } else if ((frontmatter.description as string).length > MAX_DESCRIPTION_LENGTH) {
    errors.push(`Description must be at most ${MAX_DESCRIPTION_LENGTH} characters`);
  }

  if (!body || body.trim().length === 0) {
    errors.push("Skill body (after frontmatter) must be non-empty");
  }

  return { valid: errors.length === 0, errors };
}

/** Find a skill by name (searches recursively for SKILL.md files) */
export function findSkill(skillsDir: string, name: string): string | null {
  if (!existsSync(skillsDir)) return null;

  // Check direct path: skillsDir/name/SKILL.md
  const directPath = join(skillsDir, name, "SKILL.md");
  if (existsSync(directPath)) return directPath;

  // Search recursively in category subdirectories
  const entries = readdirSync(skillsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const categoryPath = join(skillsDir, entry.name, name, "SKILL.md");
    if (existsSync(categoryPath)) return categoryPath;
  }

  return null;
}

/** Create a new skill */
export function createSkill(
  skillsDir: string,
  name: string,
  content: string,
  category?: string,
): SkillManageResult {
  const nameValidation = validateSkillName(name);
  if (!nameValidation.valid) {
    return { ok: false, error: nameValidation.errors.join("; ") };
  }

  const contentValidation = validateSkillContent(content);
  if (!contentValidation.valid) {
    return { ok: false, error: contentValidation.errors.join("; ") };
  }

  // Check for duplicates
  const existing = findSkill(skillsDir, name);
  if (existing) {
    return { ok: false, error: `Skill "${name}" already exists at ${existing}` };
  }

  const skillDir = category
    ? join(skillsDir, category, name)
    : join(skillsDir, name);

  mkdirSync(skillDir, { recursive: true });
  const skillPath = join(skillDir, "SKILL.md");
  writeFileSync(skillPath, content);

  return { ok: true, path: skillDir };
}

/** Patch an existing skill (find-and-replace in SKILL.md) */
export function patchSkill(
  skillsDir: string,
  name: string,
  oldText: string,
  newText: string,
): SkillManageResult {
  const skillPath = findSkill(skillsDir, name);
  if (!skillPath) {
    return { ok: false, error: `Skill "${name}" not found` };
  }

  const current = readFileSync(skillPath, "utf-8");

  // Check oldText exists
  const firstIdx = current.indexOf(oldText);
  if (firstIdx === -1) {
    return { ok: false, error: "oldText not found in SKILL.md" };
  }

  // Check oldText is unique
  const secondIdx = current.indexOf(oldText, firstIdx + 1);
  if (secondIdx !== -1) {
    return { ok: false, error: "oldText matches multiple locations in SKILL.md — provide a more specific string" };
  }

  const updated = current.replace(oldText, newText);

  // Validate the result still has valid frontmatter
  const contentValidation = validateSkillContent(updated);
  if (!contentValidation.valid) {
    return { ok: false, error: `Patch would produce invalid content: ${contentValidation.errors.join("; ")}` };
  }

  writeFileSync(skillPath, updated);
  return { ok: true, path: dirname(skillPath) };
}

/** Delete a skill */
export function deleteSkill(skillsDir: string, name: string): SkillManageResult {
  const skillPath = findSkill(skillsDir, name);
  if (!skillPath) {
    return { ok: false, error: `Skill "${name}" not found` };
  }

  const skillDir = dirname(skillPath);
  rmSync(skillDir, { recursive: true });

  // Clean up empty parent category dir
  const parentDir = dirname(skillDir);
  if (parentDir !== skillsDir && existsSync(parentDir)) {
    const remaining = readdirSync(parentDir);
    if (remaining.length === 0) {
      rmSync(parentDir, { recursive: true });
    }
  }

  return { ok: true };
}

/** List all agent-created skills (returns name + description from frontmatter) */
export function listLocalSkills(
  skillsDir: string,
): Array<{ name: string; description: string; category?: string; path: string }> {
  if (!existsSync(skillsDir)) return [];

  const results: Array<{ name: string; description: string; category?: string; path: string }> = [];

  function scanDir(dir: string, category?: string) {
    if (!existsSync(dir)) return;
    const entries = readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillMdPath = join(dir, entry.name, "SKILL.md");

      if (existsSync(skillMdPath)) {
        const raw = readFileSync(skillMdPath, "utf-8");
        const { frontmatter } = parseFrontmatter(raw);
        results.push({
          name: (frontmatter.name as string) ?? entry.name,
          description: (frontmatter.description as string) ?? "",
          category,
          path: join(dir, entry.name),
        });
      } else if (!category) {
        // This might be a category directory — scan one level deeper
        scanDir(join(dir, entry.name), entry.name);
      }
    }
  }

  scanDir(skillsDir);
  return results;
}
