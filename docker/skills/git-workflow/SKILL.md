---
name: git-workflow
description: Feature branch workflow with clean commits, never push to main
---

# Git Workflow

When working with git:

1. **Never commit directly to main** — always create a feature branch (`git checkout -b feat/description`)
2. **Write meaningful commit messages** — use imperative mood, explain *why* not just *what*
3. **Keep commits atomic** — each commit should represent one logical change
4. **Stage specific files** — use `git add <file>` not `git add .` to avoid committing unintended files
5. **Check before committing** — run `git diff --staged` to review what you're about to commit
6. **Don't commit secrets** — never commit API keys, tokens, .env files, or credentials
7. **Push the branch** — `git push -u origin <branch>` so the user can review and merge
