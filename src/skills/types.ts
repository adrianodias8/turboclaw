export interface SkillEntry {
  name: string;
  description: string;
  slug: string;
  /** Registry this skill came from */
  source: "clawhub" | "n-skills";
}

export interface SkillContent {
  name: string;
  /** Raw SKILL.md content (frontmatter + body) */
  content: string;
  source: "clawhub" | "n-skills";
}

export interface SkillRegistry {
  /** Search for skills matching a query string */
  search(query: string, limit: number): Promise<SkillEntry[]>;
  /** Fetch the full SKILL.md content for a skill */
  fetch(entry: SkillEntry): Promise<SkillContent | null>;
}

export interface SkillsConfig {
  autoDiscover: boolean;
  maxPerTask: number;
  registries: ("clawhub" | "n-skills")[];
}

export const DEFAULT_SKILLS_CONFIG: SkillsConfig = {
  autoDiscover: true,
  maxPerTask: 5,
  registries: ["clawhub", "n-skills"],
};
