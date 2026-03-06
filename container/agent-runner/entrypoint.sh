#!/bin/bash
set -e
cat > /tmp/input.json
node /app/dist/index.js < /tmp/input.json || (echo "Node failed"; sleep 60; exit 1)
sleep 5
