#!/bin/bash
# Fetch seed skills from the manifest into the worker image.
# Skills listed in skills-manifest.json are pre-installed to avoid cold-start latency.

set -e

MANIFEST="/opt/turboclaw/skills-manifest.json"
SKILLS_DIR="/opt/turboclaw/skills"
mkdir -p "$SKILLS_DIR"

# Parse skills array from manifest (simple jq-less approach using bun)
bun -e "
  const manifest = JSON.parse(require('fs').readFileSync('$MANIFEST', 'utf-8'));
  for (const skill of manifest.skills) {
    console.log(skill.repo || skill.url || '');
  }
" | while read -r skill; do
  if [ -n "$skill" ]; then
    echo "Fetching skill: $skill"
    cd "$SKILLS_DIR" && git clone --depth 1 "$skill" 2>/dev/null || echo "Skipping $skill (already exists or unavailable)"
  fi
done

echo "Seed skills fetched: $(ls "$SKILLS_DIR" | wc -l) installed"
