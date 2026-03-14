import { logger } from "../logger";
import type { SkillEntry, SkillContent, SkillRegistry } from "./types";

const CLAWHUB_API = "https://api.clawhub.ai/v1";
const CLAWHUB_SITE = "https://clawhub.ai";
const NSKILLS_RAW = "https://raw.githubusercontent.com/numman-ali/n-skills/main";
const NSKILLS_API = "https://api.github.com/repos/numman-ali/n-skills";

/** ClawhHub registry — semantic search over ~13k community skills */
export function createClawHubRegistry(): SkillRegistry {
  return {
    async search(query: string, limit: number): Promise<SkillEntry[]> {
      try {
        // Try the API endpoint first
        const url = `${CLAWHUB_API}/skills/search?q=${encodeURIComponent(query)}&limit=${limit}`;
        const res = await fetch(url, {
          headers: { "Accept": "application/json", "User-Agent": "TurboClaw/1.0" },
          signal: AbortSignal.timeout(10_000),
        });

        if (!res.ok) {
          // Fall back to site search
          const siteUrl = `${CLAWHUB_SITE}/api/search?q=${encodeURIComponent(query)}&limit=${limit}`;
          const siteRes = await fetch(siteUrl, {
            headers: { "Accept": "application/json", "User-Agent": "TurboClaw/1.0" },
            signal: AbortSignal.timeout(10_000),
          });
          if (!siteRes.ok) {
            logger.warn(`ClawhHub search failed: ${siteRes.status}`);
            return [];
          }
          const data = await siteRes.json() as { skills?: Array<{ name: string; description: string; slug: string }> };
          return (data.skills ?? []).map((s) => ({
            name: s.name,
            description: s.description,
            slug: s.slug,
            source: "clawhub" as const,
          }));
        }

        const data = await res.json() as { skills?: Array<{ name: string; description: string; slug: string }> };
        return (data.skills ?? []).map((s) => ({
          name: s.name,
          description: s.description,
          slug: s.slug,
          source: "clawhub" as const,
        }));
      } catch (err) {
        logger.warn(`ClawhHub search error:`, err);
        return [];
      }
    },

    async fetch(entry: SkillEntry): Promise<SkillContent | null> {
      try {
        // Try fetching the raw SKILL.md content
        const urls = [
          `${CLAWHUB_API}/skills/${entry.slug}/content`,
          `${CLAWHUB_SITE}/api/skills/${entry.slug}/raw`,
        ];

        for (const url of urls) {
          const res = await fetch(url, {
            headers: { "Accept": "text/plain,application/json", "User-Agent": "TurboClaw/1.0" },
            signal: AbortSignal.timeout(10_000),
          });
          if (res.ok) {
            const body = await res.text();
            // If response is JSON, extract the content field
            if (body.startsWith("{")) {
              try {
                const json = JSON.parse(body) as { content?: string; skill_md?: string };
                const content = json.content ?? json.skill_md;
                if (content) return { name: entry.name, content, source: "clawhub" };
              } catch { /* not JSON, use as-is */ }
            }
            // Raw SKILL.md content
            if (body.includes("---") || body.includes("name:")) {
              return { name: entry.name, content: body, source: "clawhub" };
            }
          }
        }

        logger.warn(`ClawhHub fetch failed for skill: ${entry.slug}`);
        return null;
      } catch (err) {
        logger.warn(`ClawhHub fetch error for ${entry.slug}:`, err);
        return null;
      }
    },
  };
}

/** n-skills registry — curated GitHub-based skill collection */
export function createNSkillsRegistry(): SkillRegistry {
  let skillIndex: Array<{ name: string; description: string; path: string }> | null = null;

  async function loadIndex(): Promise<typeof skillIndex> {
    if (skillIndex) return skillIndex;
    try {
      // Try fetching the index/manifest
      const indexUrl = `${NSKILLS_RAW}/skills-manifest.json`;
      const res = await fetch(indexUrl, {
        headers: { "User-Agent": "TurboClaw/1.0" },
        signal: AbortSignal.timeout(10_000),
      });

      if (res.ok) {
        const data = await res.json() as { skills?: Array<{ name: string; description: string; path: string }> };
        skillIndex = data.skills ?? [];
        return skillIndex;
      }

      // Fall back to GitHub API directory listing
      const dirUrl = `${NSKILLS_API}/contents/skills`;
      const dirRes = await fetch(dirUrl, {
        headers: { "User-Agent": "TurboClaw/1.0" },
        signal: AbortSignal.timeout(10_000),
      });

      if (dirRes.ok) {
        const entries = await dirRes.json() as Array<{ name: string; type: string }>;
        skillIndex = entries
          .filter((e) => e.type === "dir")
          .map((e) => ({
            name: e.name,
            description: e.name.replace(/-/g, " "),
            path: `skills/${e.name}/SKILL.md`,
          }));
        return skillIndex;
      }

      logger.warn(`n-skills index fetch failed`);
      skillIndex = [];
      return skillIndex;
    } catch (err) {
      logger.warn(`n-skills index error:`, err);
      skillIndex = [];
      return skillIndex;
    }
  }

  return {
    async search(query: string, limit: number): Promise<SkillEntry[]> {
      const index = await loadIndex();
      if (!index || index.length === 0) return [];

      const queryLower = query.toLowerCase();
      const keywords = queryLower.split(/\s+/).filter((w) => w.length > 2);

      // Score each skill by keyword match
      const scored = index.map((skill) => {
        const text = `${skill.name} ${skill.description}`.toLowerCase();
        let score = 0;
        for (const kw of keywords) {
          if (text.includes(kw)) score++;
        }
        return { skill, score };
      });

      return scored
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((s) => ({
          name: s.skill.name,
          description: s.skill.description,
          slug: s.skill.path,
          source: "n-skills" as const,
        }));
    },

    async fetch(entry: SkillEntry): Promise<SkillContent | null> {
      try {
        const url = `${NSKILLS_RAW}/${entry.slug}`;
        const res = await fetch(url, {
          headers: { "User-Agent": "TurboClaw/1.0" },
          signal: AbortSignal.timeout(10_000),
        });

        if (!res.ok) {
          logger.warn(`n-skills fetch failed for ${entry.slug}: ${res.status}`);
          return null;
        }

        const content = await res.text();
        return { name: entry.name, content, source: "n-skills" };
      } catch (err) {
        logger.warn(`n-skills fetch error for ${entry.slug}:`, err);
        return null;
      }
    },
  };
}
