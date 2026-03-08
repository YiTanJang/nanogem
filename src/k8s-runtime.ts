/**
 * Kubernetes Runtime for NanoGem
 * Manages agent sandboxes as native Kubernetes pods
 */
import * as k8s from '@kubernetes/client-node';
import path from 'path';
import { logger } from './logger.js';

const kc = new k8s.KubeConfig();
kc.loadFromDefault();

const k8sApi = kc.makeApiClient(k8s.CoreV1Api);
const batchApi = kc.makeApiClient(k8s.BatchV1Api);

const K8S_NAMESPACE = process.env.K8S_NAMESPACE || 'nanogem';

export interface BuildJobResult {
  status: 'success' | 'error';
  error?: string;
}

export async function runBuildJob(
  imageTag: string,
  pvcName: string,
  pvcSubPath: string,
  dockerfilePath: string = 'Dockerfile',
  contextPath: string = '.',
  shouldRollout: boolean = false,
  customJobName?: string,
): Promise<BuildJobResult> {
  const jobName = customJobName || `nanogem-build-${Date.now()}`;
  const jobSpec: k8s.V1Job = {
    metadata: { name: jobName, namespace: K8S_NAMESPACE },
    spec: {
      template: {
        spec: {
          containers: [
            {
              name: 'kaniko',
              image: 'gcr.io/kaniko-project/executor:latest',
              args: [
                `--context=dir:///workspace/${contextPath}`,
                `--dockerfile=${dockerfilePath}`,
                `--destination=${imageTag}`,
                '--skip-tls-verify',
                '--insecure',
                '--cache=true',
              ],
              volumeMounts: [{ name: 'workspace', mountPath: '/workspace', subPath: pvcSubPath }],
            },
          ],
          volumes: [{ name: 'workspace', persistentVolumeClaim: { claimName: pvcName } }],
          restartPolicy: 'Never',
        },
      },
      backoffLimit: 0,
    },
  };

  try {
    await batchApi.createNamespacedJob({ namespace: K8S_NAMESPACE, body: jobSpec });
    
    // Poll for completion
    for (let i = 0; i < 60; i++) {
      const res = await batchApi.readNamespacedJobStatus({ name: jobName, namespace: K8S_NAMESPACE });
      const status = res.status;
      if (status?.succeeded && status.succeeded > 0) {
        logger.info({ jobName }, 'Build job succeeded');
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
  } catch (err: any) {
    if (err.code === 404 || err.response?.statusCode === 404 || err.response?.body?.code === 404) {
      return; // Already gone
    }
    logger.error({ err, name }, 'Failed to delete agent pod');
  }
}

export async function runAgentPod(podSpec: k8s.V1Pod): Promise<string> {
  const res = await k8sApi.createNamespacedPod({
    namespace: K8S_NAMESPACE,
    body: podSpec,
  });
  return res.metadata?.name || '';
}

export async function cleanupOrphans(): Promise<string[]> {
  const stoppedNames: string[] = [];
  try {
    // 1. Cleanup agent pods
    const res = await k8sApi.listNamespacedPod({
      namespace: K8S_NAMESPACE,
      labelSelector: 'app.kubernetes.io/managed-by=nanogem',
    });
    const res2 = await k8sApi.listNamespacedPod({
      namespace: K8S_NAMESPACE,
      labelSelector: 'nanogem.io/group',
    });

    const pods = [...(res.items || []), ...(res2.items || [])];
    const uniquePodNames = Array.from(new Set(pods.map(p => p.metadata?.name).filter(Boolean) as string[]));

    for (const podName of uniquePodNames) {
      await stopPod(podName);
      stoppedNames.push(podName);
    }

    // 2. Cleanup old build jobs
    const jobRes = await batchApi.listNamespacedJob({ namespace: K8S_NAMESPACE });
    const jobs = jobRes.items || [];
    for (const job of jobs) {
      if (job.metadata?.name?.startsWith('nanogem-build-')) {
        const status = job.status;
        if (status?.succeeded || status?.failed) {
          logger.info({ job: job.metadata.name }, 'Cleaning up completed build job');
          await batchApi.deleteNamespacedJob({
            name: job.metadata.name!,
            namespace: K8S_NAMESPACE,
            propagationPolicy: 'Background',
          });
        }
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned resources');
  }
  return stoppedNames;
}

export async function ensureK8sReady(): Promise<void> {
  try {
    await k8sApi.listNamespacedPod({ namespace: K8S_NAMESPACE });
    logger.info({ namespace: K8S_NAMESPACE }, 'Kubernetes API connection healthy');
  } catch (err) {
    logger.error({ err }, 'Kubernetes API connection failed');
    throw err;
  }
}

export function getK8sApi() { return k8sApi; }
export { kc };
