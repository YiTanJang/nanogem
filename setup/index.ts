import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import readline from 'readline';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const question = (query: string): Promise<string> =>
  new Promise((resolve) => rl.question(query, resolve));

async function main() {
  console.log('\n=== NanoGem Kubernetes Setup ===\n');

  // 1. Check Pre-requisites
  console.log('1. Checking pre-requisites...');
  try {
    execSync('kubectl version --client', { stdio: 'ignore' });
    console.log('  ✓ kubectl is installed');
  } catch {
    console.error('  ✗ kubectl is not installed. Please install it first.');
    process.exit(1);
  }

  try {
    execSync('kubectl cluster-info', { stdio: 'ignore' });
    console.log('  ✓ Kubernetes cluster is accessible');
  } catch {
    console.error('  ✗ Cannot access Kubernetes cluster. Check your kubeconfig.');
    process.exit(1);
  }

  // 2. Configure Secrets
  console.log('\n2. Configuring Secrets...');
  const envPath = path.resolve(process.cwd(), '.env');
  let discordToken = '';
  let geminiKey = '';

  if (fs.existsSync(envPath)) {
    const env = fs.readFileSync(envPath, 'utf-8');
    discordToken = env.match(/DISCORD_BOT_TOKEN=(.*)/)?.[1] || '';
    geminiKey = env.match(/GEMINI_API_KEY=(.*)/)?.[1] || '';
  }

  if (!discordToken) discordToken = await question('Enter Discord Bot Token: ');
  if (!geminiKey) geminiKey = await question('Enter Gemini API Key: ');

  try {
    execSync(`kubectl create secret generic nanogem-secrets \
      --from-literal=DISCORD_BOT_TOKEN="${discordToken}" \
      --from-literal=GEMINI_API_KEY="${geminiKey}" \
      --namespace nanogem --dry-run=client -o yaml | kubectl apply -f -`, { stdio: 'inherit' });
    console.log('  ✓ Kubernetes secrets updated');
  } catch (err) {
    console.error('  ✗ Failed to create secrets. Ensure the "nanogem" namespace exists.');
    console.log('  (Hint: kubectl create namespace nanogem)');
    process.exit(1);
  }

  // 3. Configure Storage
  console.log('\n3. Configuring Storage (PVC)...');
  const pvcExample = 'nanogem-storage.example.yaml';
  const pvcFinal = 'nanogem-storage-final.yaml';

  if (!fs.existsSync(pvcFinal)) {
    console.log(`  Creating ${pvcFinal} from example...`);
    let content = fs.readFileSync(pvcExample, 'utf-8');
    const nfsIp = await question('Enter NFS Server IP (or leave blank for hostPath): ');
    if (nfsIp) {
      content = content.replace('<NFS_SERVER_IP>', nfsIp);
      const nfsPath = await question('Enter NFS Export Path: ');
      content = content.replace('/path/to/export', nfsPath);
    }
    fs.writeFileSync(pvcFinal, content);
    console.log(`  ✓ Created ${pvcFinal}. Please review it.`);
  }
  
  const applyPvc = await question('Apply PVC manifest now? (y/n): ');
  if (applyPvc.toLowerCase() === 'y') {
    execSync(`kubectl apply -f ${pvcFinal}`, { stdio: 'inherit' });
  }

  // 4. Configure Registry
  console.log('\n4. Configuring Image Registry...');
  console.log('  NanoGem needs a registry to store and pull agent images.');
  const regFinal = 'registry.yaml';
  let registryUrl = 'localhost:5000';

  if (fs.existsSync(regFinal)) {
    const reg = fs.readFileSync(regFinal, 'utf-8');
    registryUrl = reg.match(/url: (.*)/)?.[1] || registryUrl;
  } else {
    console.log('\n  Enter your registry address (e.g., 192.168.1.100:5000 or ghcr.io/username)');
    registryUrl = await question(`  Registry URL [${registryUrl}]: `) || registryUrl;
    fs.writeFileSync(regFinal, `url: ${registryUrl}\n`);
  }

  // 5. Initial Build & Push
  console.log('\n5. Building and Pushing Images...');
  const build = await question('Build and push images to your registry now? (y/n): ');
  if (build.toLowerCase() === 'y') {
    const orchestratorImage = `${registryUrl}/nanogem:latest`;
    const agentImage = `${registryUrl}/nanogem-agent:latest`;

    console.log(`  Building ${orchestratorImage}...`);
    execSync(`docker build -t ${orchestratorImage} .`, { stdio: 'inherit' });
    execSync(`docker push ${orchestratorImage}`, { stdio: 'inherit' });

    console.log(`  Building ${agentImage}...`);
    execSync(`docker build -t ${agentImage} -f container/Dockerfile container/`, { stdio: 'inherit' });
    execSync(`docker push ${agentImage}`, { stdio: 'inherit' });
    console.log('  ✓ Images pushed successfully');
  }

  // 6. Deploy
  console.log('\n6. Deploying NanoGem...');
  const deployExample = 'deployment.example.yaml';
  const deployFinal = 'deployment.yaml';

  if (!fs.existsSync(deployFinal)) {
    let content = fs.readFileSync(deployExample, 'utf-8');
    content = content.replace(/<REGISTRY_IP>/g, registryUrl.split(':')[0]);
    fs.writeFileSync(deployFinal, content);
    console.log(`  ✓ Created ${deployFinal}.`);
  }

  const applyDeploy = await question('Apply deployment now? (y/n): ');
  if (applyDeploy.toLowerCase() === 'y') {
    execSync(`kubectl apply -f ${deployFinal}`, { stdio: 'inherit' });
    console.log('\n  ✓ NanoGem deployed! Use "kubectl get pods -n nanogem" to check status.');
  }

  console.log('\nSetup complete! Welcome to NanoGem.');
  rl.close();
}

main().catch(console.error);
