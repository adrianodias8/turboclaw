# Git Workflow

## Commit Messages
Format: `type: concise description`

Types:
- **feat** — new feature or capability
- **fix** — bug fix
- **refactor** — restructure without behavior change
- **docs** — documentation only
- **test** — add or update tests
- **chore** — build, deps, config changes

Rules:
- Lowercase, no period at end
- Under 72 characters
- Body optional, separated by blank line

## Branching
- Never commit directly to `main`
- Feature branches: `feat/short-description`
- Fix branches: `fix/short-description`
- Self-improve tasks always create a feature branch
- Keep branches short-lived; rebase on main before merging

## Self-Improve Mode
- Always verify you are on a feature branch before committing
- Run `bun test` before every commit
- One logical change per commit — don't bundle unrelated fixes
