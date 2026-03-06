/**
 * Kubernetes Runtime for NanoClaw
 * Manages agent sandboxes as native Kubernetes pods
 */
import * as k8s from '@kubernetes/client-node';
import path from 'path';
import { logger } from './logger.js';

const kc = new k8s.KubeConfig();
kc.loadFromDefault();
const k8sApi = kc.makeApiClient(k8s.CoreV1Api);
const batchApi = kc.makeApiClient(k8s.BatchV1Api);

export const K8S_NAMESPACE = process.env.K8S_NAMESPACE || 'default';

export async function runBuildJob(
  imageTag: string,
  pvcName: string,
  pvcSubPath: string,
  dockerfilePath: string = 'Dockerfile',
  contextPath: string = '.',
  shouldRollout: boolean = false,
  customJobName?: string,
): Promise<{ status: 'success' | 'error'; error?: string }> {
  const jobName = customJobName || `nanoclaw-build-${Date.now()}`;
  
  // Resolve context path relative to the internal container mount point
  const fullContextPath = path.join('/workspace/project', contextPath);

  const jobSpec: k8s.V1Job = {
    metadata: { name: jobName },
    spec: {
      template: {
        spec: {
          serviceAccountName: 'nanoclaw-builder',
          restartPolicy: 'Never',
          containers: [
            {
              name: 'kaniko',
              image: 'gcr.io/kaniko-project/executor:latest',
              args: [
                `--dockerfile=${dockerfilePath}`,
                `--context=dir://${fullContextPath}`,
                `--destination=${imageTag}`,
                '--insecure',
                '--skip-tls-verify',
                '--digest-file=/shared/done'
              ],
              volumeMounts: [
                {
                  name: 'project-source',
                  mountPath: '/workspace/project',
                  subPath: pvcSubPath,
                },
                {
                  name: 'shared-data',
                  mountPath: '/shared',
                },
              ],
            },
            {
              name: 'rollout-trigger',
              image: 'bitnami/kubectl:latest',
              command: ['/bin/sh', '-c'],
              args: [
                `
                echo "Waiting for kaniko to finish..."
                while [ ! -s /shared/done ]; do 
                  if [ -f /shared/error ]; then echo "Build failed"; exit 1; fi
                  sleep 2
                done
                if [ "${shouldRollout}" = "true" ]; then
                  echo "Build successful, triggering rollout..."
                  kubectl patch deployment nanoclaw -p "{\\\"spec\\\":{\\\"template\\\":{\\\"metadata\\\":{\\\"annotations\\\":{\\\"kubectl.kubernetes.io/restartedAt\\\":\\\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\\\"}}}}} "
                else
                  echo "Build successful, skipping rollout as requested."
                fi
                `
              ],
              volumeMounts: [
                {
                  name: 'shared-data',
                  mountPath: '/shared',
                },
              ],
            },
          ],
          volumes: [
            {
              name: 'project-source',
              persistentVolumeClaim: { claimName: pvcName },
            },
            {
              name: 'shared-data',
              emptyDir: {},
            },
          ],
        },
      },
      backoffLimit: 0,
    },
  };

  try {
    logger.info({ jobName, imageTag, contextPath, shouldRollout }, 'Starting dynamic Kaniko build job');
    await batchApi.createNamespacedJob({
      namespace: K8S_NAMESPACE,
      body: jobSpec,
    });

    // Poll for completion
    for (let i = 0; i < 60; i++) { // 10 minute timeout (10s * 60)
      const res = await batchApi.readNamespacedJobStatus({
        name: jobName,
        namespace: K8S_NAMESPACE,
      });
      const status = res.status;
      if (status?.succeeded && status.succeeded > 0) {
        logger.info({ jobName }, 'Build job succeeded');
        // Clean up successful job
        await batchApi.deleteNamespacedJob({ name: jobName, namespace: K8S_NAMESPACE });
        return { status: 'success' };
      }
      if (status?.failed && status.failed > 0) {
        const error = 'Kaniko build job failed';
        logger.error({ jobName }, error);
        return { status: 'error', error };
      }
      await new Promise((r) => setTimeout(r, 10000));
    }

    return { status: 'error', error: 'Build job timed out' };
  } catch (err) {
    logger.error({ err, jobName }, 'Failed to trigger build job');
    return { status: 'error', error: String(err) };
  }
}

export async function stopPod(name: string): Promise<void> {
  try {
    await k8sApi.deleteNamespacedPod({ name, namespace: K8S_NAMESPACE });
    logger.info({ name, namespace: K8S_NAMESPACE }, 'Deleted agent pod');
  } catch (err) {
    logger.error({ err, name }, 'Failed to delete agent pod');
  }
}

export async function ensureK8sReady(): Promise<void> {
  try {
    await k8sApi.listNamespacedPod({ namespace: K8S_NAMESPACE });
    logger.info(
      { namespace: K8S_NAMESPACE },
      'Kubernetes API connection healthy',
    );
  } catch (err) {
    logger.error({ err }, 'Kubernetes API connection failed');
    throw new Error('Kubernetes is enabled but API is unreachable');
  }
}

export async function runAgentPod(podSpec: k8s.V1Pod): Promise<string> {
  const res = await k8sApi.createNamespacedPod({
    namespace: K8S_NAMESPACE,
    body: podSpec,
  });
  return res.metadata?.name || '';
}

export async function cleanupOrphans(): Promise<void> {
  try {
    // Cleanup agent pods using both legacy and current labels
    const res = await k8sApi.listNamespacedPod({
      namespace: K8S_NAMESPACE,
      labelSelector: 'app.kubernetes.io/managed-by=nanoclaw',
    });
    const res2 = await k8sApi.listNamespacedPod({
      namespace: K8S_NAMESPACE,
      labelSelector: 'nanoclaw.io/group',
    });

    const pods = [...(res.items || []), ...(res2.items || [])];
    const uniquePods = Array.from(new Set(pods.map(p => p.metadata?.name)))
      .map(name => pods.find(p => p.metadata?.name === name));

    for (const pod of uniquePods) {
      if (pod && pod.metadata?.name) {
        await stopPod(pod.metadata.name);
      }
    }

    if (uniquePods.length > 0) {
      logger.info(
        { count: uniquePods.length, names: uniquePods.map((p) => p?.metadata?.name) },
        'Stopped orphaned agent pods',
      );
    }

    // Cleanup old build jobs
    const jobRes = await batchApi.listNamespacedJob({
      namespace: K8S_NAMESPACE,
    });
    const jobs = jobRes.items || [];
    for (const job of jobs) {
      if (job.metadata?.name?.startsWith('nanoclaw-build-')) {
        const status = job.status;
        if (status?.succeeded || status?.failed) {
          logger.info({ job: job.metadata.name }, 'Cleaning up completed build job');
          await batchApi.deleteNamespacedJob({
            name: job.metadata.name,
            namespace: K8S_NAMESPACE,
            propagationPolicy: 'Background',
          });
        }
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned resources');
  }
}
