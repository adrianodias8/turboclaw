import { useState, useEffect } from "react";
import { join } from "path";
import { listNotes } from "../../memory/vault";
import type { MemoryNote } from "../../memory/types";

const TIER_DIRS: Record<string, string> = {
  core: "core",
  daily: "tasks",
  weekly: "weekly",
  agent: "agents",
};

export function useMemoryNotes(vaultPath: string, tier: "core" | "daily" | "weekly" | "agent"): MemoryNote[] {
  const [notes, setNotes] = useState<MemoryNote[]>([]);

  useEffect(() => {
    const subdir = TIER_DIRS[tier];
    const refresh = () => {
      const loaded = listNotes(vaultPath, subdir);
      loaded.sort((a, b) => b.frontmatter.created - a.frontmatter.created);
      setNotes(loaded);
    };
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [vaultPath, tier]);

  return notes;
}
