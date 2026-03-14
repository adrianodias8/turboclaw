/**
 * Completion protocol preamble injected into every task prompt.
 * Instructs the agent to self-assess before finishing and create
 * follow-up tasks via the TurboClaw API if work remains incomplete.
 */
export function completionProtocol(taskId: string, apiUrl: string): string {
  return `# Completion Protocol

Before you finish, you MUST perform a self-assessment:

1. **Re-read the original request** at the bottom of this prompt.
2. **Check your work** — did you fully address every part of the request? Run tests, verify output, review changes.
3. **If the task is fully complete:** report what you did and exit normally.
4. **If work remains that you cannot finish in this session:** create a follow-up task using the TurboClaw API, then exit. The follow-up will be picked up automatically by another agent.

To create a follow-up task:
\`\`\`bash
curl -s -X POST "${apiUrl}/tasks" \\
  -H 'Content-Type: application/json' \\
  -d '{
    "title": "<concise title of remaining work>",
    "description": "<detailed description including:\\n- What was already completed (reference task ${taskId})\\n- What specifically remains to be done\\n- Any context the next agent needs>",
    "agentRole": "coder",
    "priority": 5
  }'
\`\`\`

**Rules:**
- Do NOT create a follow-up for trivial cleanup — only for substantive incomplete work.
- Do NOT create circular follow-ups — if you tried something and it failed, explain why in the follow-up description so the next agent tries a different approach.
- Always include what was already done so the next agent doesn't repeat work.
- If you create a follow-up, say so clearly in your final output.

---
`;
}
