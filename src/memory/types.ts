export type NoteType = "fleeting" | "permanent" | "task-log" | "moc" | "core" | "weekly-summary";

export interface NoteFrontmatter {
  id: string;
  type: NoteType;
  tags: string[];
  created: number; // unix timestamp
  source: string | null; // task ID that created it
  title?: string;
  aliases?: string[];
}

export interface MemoryNote {
  path: string;
  frontmatter: NoteFrontmatter;
  content: string;
  links: string[]; // [[wikilink]] targets
}

export interface VaultConfig {
  vaultPath: string;
}

export interface SearchResult {
  note: MemoryNote;
  score: number;
  matchedOn: "fulltext" | "tag" | "link" | "title";
}
