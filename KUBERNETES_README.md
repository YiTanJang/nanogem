# Kubernetes Deployment Guides

This folder contains example manifests to run NanoClaw in a Kubernetes cluster (like K3s on a NAS).

1. **Storage**: Copy `nanoclaw-storage.example.yaml` to `nanoclaw-storage-final.yaml`. Update the `<NFS_SERVER_IP>` and the path to match your NAS/NFS configuration. Apply it.
2. **Secrets**: Create a secret named `nanoclaw-secrets` containing your `DISCORD_BOT_TOKEN` and `GEMINI_API_KEY`. (See README for the kubectl command).
3. **Deployment**: Copy `deployment.example.yaml` to `deployment.yaml`. Replace all instances of `<REGISTRY_IP>` with the IP of your container registry. Apply it.

Note: `deployment.yaml` and `nanoclaw-storage-final.yaml` are explicitly ignored by `.gitignore` so your private IP addresses and NAS paths are never committed.
