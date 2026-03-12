import { Database } from "bun:sqlite";
import { loadConfig } from "../src/config";
import { createStore } from "../src/tracker/store";

const config = loadConfig();
const db = new Database(config.dbPath);
const store = createStore(db);

// Create a sample pipeline
const pipeline = store.createPipeline({
  name: "default",
  stages: [
    { name: "code", description: "Write or modify code" },
    { name: "review", description: "Review changes" },
    { name: "deploy", description: "Deploy to staging" },
  ],
});

console.log(`Created pipeline: ${pipeline.name} (${pipeline.id})`);

// Create sample tasks
const tasks = [
  { title: "Fix login page redirect", agentRole: "coder" as const, priority: 10 },
  { title: "Add unit tests for auth module", agentRole: "coder" as const, priority: 5 },
  { title: "Review PR #42 — database migration", agentRole: "reviewer" as const, priority: 8 },
  { title: "Refactor API error handling", agentRole: "coder" as const, priority: 3 },
  { title: "Update deployment docs", agentRole: "coder" as const, priority: 1 },
];

for (const t of tasks) {
  const task = store.createTask({
    pipelineId: pipeline.id,
    stage: "code",
    ...t,
  });
  // Queue the first 3
  if (t.priority >= 5) {
    store.updateTaskStatus(task.id, "queued");
  }
  console.log(`Created task: ${task.title} (${task.status})`);
}

console.log("\nSeed complete. Run `bun run src/index.ts` to start TurboClaw.");
db.close();
