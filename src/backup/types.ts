export interface BackupManifest {
  version: 1;
  createdAt: number; // unix timestamp
  components: BackupComponent[];
}

export interface BackupComponent {
  name: string; // "config" | "database" | "memory" | "skills" | "checkpoints"
  fileCount: number;
  sizeBytes: number;
}

export interface BackupResult {
  ok: boolean;
  path?: string;
  sizeBytes?: number;
  manifest?: BackupManifest;
  error?: string;
}

export interface RestoreResult {
  ok: boolean;
  restoredComponents?: string[];
  safetyBackupPath?: string;
  error?: string;
}
