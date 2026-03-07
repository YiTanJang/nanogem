# NanoGem Debug Checklist

## Quick Status Check

```bash
# 1. Is the service running?
kubectl get pods -n nanogem

# 2. Any running agent pods?
kubectl get pods -n nanogem | grep agent

# 3. Recent errors in service log?
kubectl logs deployment/nanogem -n nanogem --tail=100 | grep -E 'ERROR|WARN'

# 4. Is Discord connected?
kubectl logs deployment/nanogem -n nanogem --tail=100 | grep -E 'Connected to Discord|Discord connection'

# 5. Are groups loaded?
kubectl logs deployment/nanogem -n nanogem --tail=100 | grep 'groupCount'
```

## Session Transcript Investigation

```bash
# Check for session history in .gemini/ directory
ls -la data/sessions/<group>/.gemini/
```

## Pod Timeout Investigation

```bash
# Check for recent timeouts
kubectl logs deployment/nanogem -n nanogem --tail=500 | grep -E 'Pod reached max life|timed out'

# Check if retries were scheduled and what happened
kubectl logs deployment/nanogem -n nanogem --tail=500 | grep -E 'Scheduling retry|retry|Max retries'
```

## Agent Not Responding

```bash
# Check if messages are being received from Discord
kubectl logs deployment/nanogem -n nanogem --tail=100 | grep 'Raw Discord message received'

# Check if a bot message (mention/DM) was recognized
kubectl logs deployment/nanogem -n nanogem --tail=100 | grep 'Discord bot message received'

# Check if messages are being processed (pod created)
kubectl logs deployment/nanogem -n nanogem --tail=100 | grep -E 'Processing messages|Creating agent pod'

# Check if messages are being piped to active pod
kubectl logs deployment/nanogem -n nanogem --tail=100 | grep -E 'Piped message|sendMessage'

# Check the queue state
kubectl logs deployment/nanogem -n nanogem --tail=100 | grep -E 'Starting pod|Pod active'

# Check lastAgentTimestamp vs latest message timestamp
sqlite3 store/messages.db "SELECT chat_jid, MAX(timestamp) as latest FROM messages GROUP BY chat_jid ORDER BY latest DESC LIMIT 5;"
```

## Pod Mount Issues

```bash
# Check mount validation logs (shows on pod creation)
kubectl logs deployment/nanogem -n nanogem --tail=100 | grep -E 'Mount validated|Mount.*REJECTED|mount'

# Verify the mount allowlist is readable
cat ~/.config/nanogem/mount-allowlist.json

# Check group's container_config in DB
sqlite3 store/messages.db "SELECT name, container_config FROM registered_groups;"
```

## Discord Auth Issues

```bash
# Check if token is configured
grep 'DISCORD_BOT_TOKEN' .env

# Check for connection errors
kubectl logs deployment/nanogem -n nanogem --tail=100 | grep -i 'failed to connect to discord'
```

## Service Management

```bash
# Restart the orchestrator
kubectl rollout restart deployment nanogem -n nanogem

# View live logs
kubectl logs -f deployment/nanogem -n nanogem

# Rebuild and restart after code changes
# (Assuming your K8s deployment mounts the NAS volume where you build)
npm run build && kubectl rollout restart deployment nanogem -n nanogem
```
