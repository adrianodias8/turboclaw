# Security

## Secrets
- Never hardcode API keys, tokens, or passwords
- Use environment variables or mounted credential files
- If a secret is exposed, rotate it immediately
- Never log secrets — sanitize before logging

## SQL Injection Prevention
- Always use `db.prepare()` with parameterized queries
- Never use string interpolation or template literals in SQL
- Validate and type-check inputs before query execution

## Input Validation
- Validate all external input at API boundaries
- Reject unexpected types early (use TypeScript narrowing)
- Sanitize user-provided strings before storage or display
- Limit string lengths and array sizes at entry points

## Container Security
- Mount credential directories read-only when possible
- Never expose Docker socket to worker containers
- Worker containers are ephemeral — destroy after task completion
- Do not pass secrets via command-line arguments (use env vars)

## Output
- Never include stack traces in API responses
- Log errors with context but without sensitive data
- Sanitize file paths in logs (no home directory exposure)
