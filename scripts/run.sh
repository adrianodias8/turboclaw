#!/bin/bash
# TurboClaw process wrapper — restarts on exit code 75 (self-improve restart)
while true; do
  bun run src/index.ts "$@"
  EXIT_CODE=$?
  if [ $EXIT_CODE -eq 75 ]; then
    echo "[TurboClaw] Restarting after self-improve..."
    sleep 1
    continue
  fi
  exit $EXIT_CODE
done
