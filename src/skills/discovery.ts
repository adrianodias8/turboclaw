import { logger } from "../logger";
import { createClawHubRegistry, createNSkillsRegistry } from "./registry";
import { createSkillCache } from "./cache";
import type { SkillRegistry, SkillsConfig, SkillEntry } from "./types";
import { DEFAULT_SKILLS_CONFIG } from "./types";

// Stop words to filter from keyword extraction
const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "is", "it", "that", "this", "are", "was",
  "be", "have", "has", "had", "do", "does", "did", "will", "would",
  "could", "should", "may", "might", "can", "not", "no", "if", "then",
  "else", "when", "what", "which", "who", "how", "all", "each", "every",
  "any", "some", "my", "your", "our", "their", "its", "i", "you", "we",
  "they", "me", "him", "her", "us", "them", "so", "just", "also", "very",
  "about", "up", "out", "into", "over", "after", "before", "between",
  "under", "above", "below", "more", "less", "than", "too", "as", "like",
  "make", "use", "using", "please", "need", "want", "create", "write",
  "build", "implement", "add", "fix", "update", "change", "modify",
  "file", "code", "project", "task", "work",
]);

/**
 * Extract meaningful keywords from a task prompt for skill search.
 * Filters stop words and keeps domain-specific terms.
 */
export function extractKeywords(prompt: string, maxKeywords: number = 8): string[] {
  const words = prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));

  // Deduplicate and take top keywords
  const unique = [...new Set(words)];
  return unique.slice(0, maxKeywords);
}

/**
 * Discover skills matching a task prompt from configured registries.
 * Returns the names of cached skills that should be injected into the container.
 */
export async function discoverSkills(
  prompt: string,
  projectRoot: string,
  skillsConfig?: Partial<SkillsConfig>,
): Promise<string[]> {
  const config: SkillsConfig = { ...DEFAULT_SKILLS_CONFIG, ...skillsConfig };

  if (!config.autoDiscover) return [];

  const cache = createSkillCache(projectRoot);
  const keywords = extractKeywords(prompt);

  if (keywords.length === 0) {
    logger.info("No meaningful keywords extracted from prompt, skipping skill discovery");
    return [];
  }

  const query = keywords.join(" ");
  logger.info(`Skill discovery: searching for "${query}" (max ${config.maxPerTask})`);

  // Build registries based on config
  const registries: Array<{ name: string; registry: SkillRegistry }> = [];
  for (const regName of config.registries) {
    if (regName === "clawhub") {
      registries.push({ name: "clawhub", registry: createClawHubRegistry() });
    } else if (regName === "n-skills") {
      registries.push({ name: "n-skills", registry: createNSkillsRegistry() });
    }
  }

  // Search all registries in parallel
  const searchResults = await Promise.all(
    registries.map(async ({ name, registry }) => {
      try {
        const results = await registry.search(query, config.maxPerTask);
        logger.info(`Registry "${name}": found ${results.length} skills`);
        return { name, registry, results };
      } catch (err) {
        logger.warn(`Registry "${name}" search failed:`, err);
        return { name, registry, results: [] as SkillEntry[] };
      }
    }),
  );

  // Deduplicate by skill name, preferring earlier registries
  const seen = new Set<string>();
  const toFetch: Array<{ entry: SkillEntry; registry: SkillRegistry }> = [];

  for (const { registry, results } of searchResults) {
    for (const entry of results) {
      if (seen.has(entry.name)) continue;
      seen.add(entry.name);

      // Skip if already cached
      if (cache.has(entry.name)) {
        logger.info(`Skill "${entry.name}" already cached, skipping fetch`);
        continue;
      }

      if (toFetch.length < config.maxPerTask) {
        toFetch.push({ entry, registry });
      }
    }
  }

  // Fetch uncached skills in parallel
  if (toFetch.length > 0) {
    logger.info(`Fetching ${toFetch.length} uncached skills...`);

    const fetchResults = await Promise.all(
      toFetch.map(async ({ entry, registry }) => {
        try {
          const content = await registry.fetch(entry);
          if (content) {
            cache.put(content);
            logger.info(`Cached skill: ${content.name} (from ${content.source})`);
            return content.name;
          }
          return null;
        } catch (err) {
          logger.warn(`Failed to fetch skill "${entry.name}":`, err);
          return null;
        }
      }),
    );

    const fetched = fetchResults.filter((n): n is string => n !== null);
    logger.info(`Fetched ${fetched.length}/${toFetch.length} skills`);
  }

  // Return all skill names that matched (cached + newly fetched), limited to maxPerTask
  const allMatched = [...seen].filter((name) => cache.has(name));
  const result = allMatched.slice(0, config.maxPerTask);

  logger.info(`Skill discovery complete: ${result.length} skills selected → [${result.join(", ")}]`);
  return result;
}
