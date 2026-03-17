import { join } from "path";
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync, unlinkSync } from "fs";
import { logger } from "../logger";

export interface Instinct {
  id: string;
  trigger: string;
  action: string;
  confidence: number; // 0.3 to 0.9
  domain: string;
  scope: "project" | "global";
  evidence: string[];
  source: string; // task ID that created/last updated it
  created: string; // ISO date
}

const INSTINCTS_DIR = "instincts";

function instinctsDir(vaultPath: string): string {
  return join(vaultPath, INSTINCTS_DIR);
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Parse an instinct from a markdown file with YAML-like frontmatter.
 */
function parseInstinct(content: string): Instinct | null {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return null;

  const frontmatter = match[1]!;
  const body = match[2]!.trim();

  const get = (key: string): string => {
    const m = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
    return m?.[1]?.trim() ?? "";
  };

  const getList = (key: string): string[] => {
    const m = frontmatter.match(new RegExp(`^${key}:\\s*\\[(.+)\\]$`, "m"));
    if (!m) return [];
    return m[1]!.split(",").map(s => s.trim().replace(/^['"]|['"]$/g, ""));
  };

  const id = get("id");
  if (!id) return null;

  return {
    id,
    trigger: get("trigger"),
    action: body.split("\n")[0]?.replace(/^#\s*/, "") ?? "",
    confidence: parseFloat(get("confidence")) || 0.5,
    domain: get("domain") || "general",
    scope: (get("scope") as "project" | "global") || "project",
    evidence: getList("evidence"),
    source: get("source"),
    created: get("created"),
  };
}

/**
 * List all instincts from the vault.
 */
export function listInstincts(vaultPath: string): Instinct[] {
  const dir = instinctsDir(vaultPath);
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter(f => f.endsWith(".md"))
    .map(f => {
      try {
        const content = readFileSync(join(dir, f), "utf-8");
        return parseInstinct(content);
      } catch {
        return null;
      }
    })
    .filter((i): i is Instinct => i !== null);
}

/**
 * Find instincts relevant to a query string, sorted by relevance * confidence.
 */
export function matchInstincts(
  vaultPath: string,
  query: string,
  maxInstincts: number = 5
): Instinct[] {
  const all = listInstincts(vaultPath);
  const queryLower = query.toLowerCase();
  const queryWords = queryLower.split(/\s+/).filter(w => w.length > 3);

  const scored = all
    .map(instinct => {
      const triggerLower = instinct.trigger.toLowerCase();
      const actionLower = instinct.action.toLowerCase();
      const domainLower = instinct.domain.toLowerCase();

      let relevance = 0;
      for (const word of queryWords) {
        if (triggerLower.includes(word)) relevance += 2;
        if (actionLower.includes(word)) relevance += 1;
        if (domainLower.includes(word)) relevance += 1;
      }

      return { instinct, score: relevance * instinct.confidence };
    })
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxInstincts);

  return scored.map(s => s.instinct);
}

/**
 * Write or update an instinct to the vault.
 */
export function saveInstinct(vaultPath: string, instinct: Instinct): void {
  const dir = instinctsDir(vaultPath);
  ensureDir(dir);

  const content = [
    "---",
    `id: ${instinct.id}`,
    `trigger: ${instinct.trigger}`,
    `confidence: ${instinct.confidence}`,
    `domain: ${instinct.domain}`,
    `scope: ${instinct.scope}`,
    `evidence: [${instinct.evidence.map(e => `"${e}"`).join(", ")}]`,
    `source: ${instinct.source}`,
    `created: ${instinct.created}`,
    "---",
    "",
    `# ${instinct.action}`,
  ].join("\n");

  writeFileSync(join(dir, `${instinct.id}.md`), content);
}

/**
 * Update confidence for an instinct. Clamps to [0.1, 0.95].
 */
export function updateConfidence(
  vaultPath: string,
  instinctId: string,
  delta: number
): void {
  const all = listInstincts(vaultPath);
  const instinct = all.find(i => i.id === instinctId);
  if (!instinct) return;

  instinct.confidence = Math.max(0.1, Math.min(0.95, instinct.confidence + delta));
  saveInstinct(vaultPath, instinct);
}

/**
 * Extract instincts from a completed task's output using keyword heuristics.
 * Returns instincts that should be saved to the vault.
 */
export function extractInstincts(
  taskTitle: string,
  taskOutput: string,
  taskId: string
): Instinct[] {
  const instincts: Instinct[] = [];
  const outputLower = taskOutput.toLowerCase();
  const now = new Date().toISOString();

  // Pattern: "switched from X to Y" / "replaced X with Y" / "instead of X, use Y"
  const switchPatterns = [
    /(?:switched|changed|replaced|moved)\s+(?:from\s+)?(\S+)\s+(?:to|with)\s+(\S+)/gi,
    /instead\s+of\s+(\S+)[\s,]+(?:use|prefer)\s+(\S+)/gi,
  ];
  for (const pattern of switchPatterns) {
    for (const match of taskOutput.matchAll(pattern)) {
      const from = match[1]!;
      const to = match[2]!;
      instincts.push({
        id: `prefer-${to.toLowerCase().replace(/[^a-z0-9]/g, "-")}-over-${from.toLowerCase().replace(/[^a-z0-9]/g, "-")}`,
        trigger: `when choosing between ${from} and ${to}`,
        action: `Prefer ${to} over ${from}`,
        confidence: 0.5,
        domain: "tooling",
        scope: "project",
        evidence: [`Task ${taskId}: ${taskTitle}`],
        source: taskId,
        created: now,
      });
    }
  }

  // Pattern: repeated error resolution — "fixed by" / "resolved by" / "the fix was"
  const fixPatterns = /(?:fixed|resolved|solved|the fix was)\s+(?:by\s+)?(.{10,80})/gi;
  for (const match of taskOutput.matchAll(fixPatterns)) {
    const fix = match[1]!.replace(/[.!]$/, "").trim();
    const id = fix.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 50);
    instincts.push({
      id: `fix-${id}`,
      trigger: "when encountering a similar error",
      action: fix,
      confidence: 0.4,
      domain: "debugging",
      scope: "project",
      evidence: [`Task ${taskId}: ${taskTitle}`],
      source: taskId,
      created: now,
    });
  }

  // Pattern: "should always" / "must always" / "never X"
  const rulePatterns = /(?:should|must)\s+always\s+(.{10,80})/gi;
  for (const match of taskOutput.matchAll(rulePatterns)) {
    const rule = match[1]!.replace(/[.!]$/, "").trim();
    const id = rule.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 50);
    instincts.push({
      id: `rule-${id}`,
      trigger: "during development",
      action: rule,
      confidence: 0.4,
      domain: "best-practice",
      scope: "project",
      evidence: [`Task ${taskId}: ${taskTitle}`],
      source: taskId,
      created: now,
    });
  }

  return instincts;
}

/**
 * Decay instincts that haven't been used recently and prune low-confidence ones.
 * - Reduces confidence by 0.05 for instincts not updated in the last 7 days
 * - Deletes instincts with confidence below 0.1
 * - Caps evidence array at 20 entries
 */
export function decayInstincts(vaultPath: string): { decayed: number; pruned: number } {
  const all = listInstincts(vaultPath);
  const dir = instinctsDir(vaultPath);
  const now = Date.now();
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  let decayed = 0;
  let pruned = 0;

  for (const instinct of all) {
    const filePath = join(dir, `${instinct.id}.md`);
    let modified = false;

    // Check file modification time to determine "last used"
    try {
      const stat = Bun.file(filePath);
      const mtime = stat.lastModified;
      if (now - mtime > sevenDaysMs) {
        instinct.confidence -= 0.05;
        modified = true;
        decayed++;
      }
    } catch {
      // If we can't stat, apply decay anyway
      instinct.confidence -= 0.05;
      modified = true;
      decayed++;
    }

    // Cap evidence array at 20 entries
    if (instinct.evidence.length > 20) {
      instinct.evidence = instinct.evidence.slice(-20);
      modified = true;
    }

    // Delete if confidence too low
    if (instinct.confidence < 0.1) {
      try {
        unlinkSync(filePath);
        pruned++;
      } catch {
        // File may already be gone
      }
      continue;
    }

    if (modified) {
      saveInstinct(vaultPath, instinct);
    }
  }

  if (decayed > 0 || pruned > 0) {
    logger.info(`Instinct decay: ${decayed} decayed, ${pruned} pruned`);
  }

  return { decayed, pruned };
}

/**
 * Build prompt context from matched instincts.
 */
export function buildInstinctContext(vaultPath: string, query: string, maxInstincts: number = 3): string {
  const matched = matchInstincts(vaultPath, query, maxInstincts);
  if (matched.length === 0) return "";

  const sections = matched.map(i =>
    `- **${i.action}** (${i.domain}, confidence: ${i.confidence}) — trigger: ${i.trigger}`
  );

  return `# Learned Instincts\n\n${sections.join("\n")}`;
}
