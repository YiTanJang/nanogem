#!/bin/bash
# Build the NanoClaw agent container image

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

IMAGE_NAME="nanoclaw-agent"
TAG="${1:-latest}"
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-docker}"

# If runtime is k8s, we still use docker (or potentially buildah/kaniko) to build the image
# but we might want to push it to a registry or load it into a local k8s cluster (kind/minikube).
BUILD_RUNTIME=$CONTAINER_RUNTIME
if [ "$BUILD_RUNTIME" == "k8s" ]; then
    BUILD_RUNTIME="docker"
fi

echo "Building NanoClaw agent container image..."
echo "Image: ${IMAGE_NAME}:${TAG}"

${BUILD_RUNTIME} build -t "${IMAGE_NAME}:${TAG}" .

echo ""
echo "Build complete!"
echo "Image: ${IMAGE_NAME}:${TAG}"

if [ "$CONTAINER_RUNTIME" == "k8s" ]; then
    echo ""
    echo "Note: Running in Kubernetes mode. You may need to push this image to a registry"
    echo "or load it into your local cluster (e.g., 'kind load docker-image ${IMAGE_NAME}:${TAG}')."
fi
echo ""
echo "Test with:"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' | ${CONTAINER_RUNTIME} run -i ${IMAGE_NAME}:${TAG}"
