export interface ApiError {
  error: string;
}

export interface HealthResponse {
  ok: true;
}

export interface StatusResponse {
  queueDepth: number;
  activeWorkers: number;
}
