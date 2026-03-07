# NanoClaw Debug Checklist

## Quick Status Check

```bash
# 1. Is the service running?
# Linux (systemd)
systemctl --user status nanoclaw
# macOS (launchd)
launchctl list | grep nanoclaw

# 2. Any running containers or pods?
docker ps --format '{{.Names}} {{.Status}}' 2>/dev/null | grep nanoclaw
kubectl get pods -n nanoclaw

# 3. Recent errors in service log?
grep -E 'ERROR|WARN' logs/nanoclaw.log | tail -20

# 4. Is Discord connected?
grep -E 'Connected to Discord|Discord connection' logs/nanoclaw.log | tail -5

# 5. Are groups loaded?
grep 'groupCount' logs/nanoclaw.log | tail -3
```

## Session Transcript Investigation

```bash
# Check for session history in .gemini/ directory
ls -la data/sessions/<group>/.gemini/

# Check for session history file
ls -la groups/<group>/.nanoclaw/history.json
```

## Container/Pod Timeout Investigation

```bash
# Check for recent timeouts
grep -E 'Container timeout|timed out|Pod reached max life' logs/nanoclaw.log | tail -10

# Check container log files for the timed-out container
ls -lt groups/*/logs/container-*.log | head -10

# Read the most recent container log (replace path)
cat groups/<group>/logs/container-<timestamp>.log

# Check if retries were scheduled and what happened
grep -E 'Scheduling retry|retry|Max retries' logs/nanoclaw.log | tail -10
```

## Agent Not Responding

```bash
# Check if messages are being received from Discord
grep 'Raw Discord message received' logs/nanoclaw.log | tail -10

# Check if a bot message (mention/DM) was recognized
grep 'Discord bot message received' logs/nanoclaw.log | tail -10

# Check if messages are being processed (container spawned)
grep -E 'Processing messages|Creating agent pod' logs/nanoclaw.log | tail -10

# Check if messages are being piped to active container
grep -E 'Piped message|sendMessage' logs/nanoclaw.log | tail -10

# Check the queue state — any active containers?
grep -E 'Starting container|Container active|concurrency limit' logs/nanoclaw.log | tail -10

# Check lastAgentTimestamp vs latest message timestamp
sqlite3 store/messages.db "SELECT chat_jid, MAX(timestamp) as latest FROM messages GROUP BY chat_jid ORDER BY latest DESC LIMIT 5;"
```

## Container/Pod Mount Issues

```bash
# Check mount validation logs (shows on container spawn)
grep -E 'Mount validated|Mount.*REJECTED|mount' logs/nanoclaw.log | tail -10

# Verify the mount allowlist is readable
cat ~/.config/nanoclaw/mount-allowlist.json

# Check group's container_config in DB
sqlite3 store/messages.db "SELECT name, container_config FROM registered_groups;"

# Test-run a container to check mounts (dry run)
docker run -i --rm --entrypoint ls nanoclaw-agent:latest /workspace/extra/
```

## Discord Auth Issues

```bash
# Check if token is configured
grep 'DISCORD_BOT_TOKEN' .env

# Check for connection errors
grep -i 'failed to connect to discord' logs/nanoclaw.log | tail -5
```

## Service Management

```bash
# Linux (systemd)
systemctl --user restart nanoclaw
systemctl --user stop nanoclaw
systemctl --user start nanoclaw

# macOS (launchd)
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# View live logs
tail -f logs/nanoclaw.log

# Rebuild and restart after code changes
npm run build && systemctl --user restart nanoclaw
```
