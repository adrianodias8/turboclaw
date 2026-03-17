export interface TestMetrics {
  passed: number;
  failed: number;
  total: number;
  durationMs: number;
  raw: string;
}

export interface ProgramConfig {
  content: string;
  constraints: string[];
  priorities: string[];
}
