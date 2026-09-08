/**
 * W6-4A — infrastructure/security source locks (owner directive §28):
 * static assertions over the Dockerfile, the container harness, the
 * Terraform modules/stack, the GitHub workflows, and the application's
 * production boundaries. These are not documentation: a regression in any
 * invariant fails the backend suite.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8');

function walk(dir: string, ext: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (entry === '.terraform') continue;
    if (statSync(full).isDirectory()) out.push(...walk(full, ext));
    else if (full.endsWith(ext)) out.push(full);
  }
  return out;
}

/** Drops full-line comments so prose about a forbidden thing never trips a lock. */
function stripComments(text: string, marker: string): string {
  return text.split('\n').filter((line) => !line.trimStart().startsWith(marker)).join('\n');
}

const tfFiles = walk(path.join(ROOT, 'infra', 'terraform'), '.tf');
const tfAll = tfFiles.map((f) => readFileSync(f, 'utf8')).join('\n');
const tfOf = (name: string): string => tfFiles.filter((f) => f.includes(name)).map((f) => readFileSync(f, 'utf8')).join('\n');

describe('Dockerfile — the ONE production artifact', () => {
  const dockerfile = read('backend/Dockerfile');
  const dockerignore = read('backend/.dockerignore');

  it('multi-stage, Node 24, non-root user, node as PID 1, no secrets in ARG/ENV, no .env, no dev executables', () => {
    expect(dockerfile).toMatch(/FROM \$\{NODE_IMAGE\} AS deps/);
    expect(dockerfile).toMatch(/FROM \$\{NODE_IMAGE\} AS runtime/);
    expect(dockerfile).toContain('node:24-');
    expect(dockerfile).toContain('npm ci --omit=dev');
    expect(dockerfile).toMatch(/^USER himma:himma$/m);
    // In-process loader (the tsx CLI forks a child and needs a writable /tmp
    // IPC socket): the application is PID 1 and needs no writable path.
    expect(dockerfile).toContain('ENTRYPOINT ["node", "--import", "/app/node_modules/tsx/dist/loader.mjs"]');
    expect(dockerfile).not.toContain('tsx/dist/cli.mjs');
    expect(dockerfile).toMatch(/^\s*TSX_DISABLE_CACHE=1/m);
    // ADD --chmod applies to created directories too; the trust directory must stay traversable.
    expect(dockerfile).toContain('chmod 0555 /etc/himma /etc/himma/certs');
    const instructions = dockerfile.split('\n').filter((line) => !line.trimStart().startsWith('#'));
    const joined = instructions.join('\n');
    expect(joined).not.toMatch(/^COPY .*\.env/m);
    expect(joined).not.toMatch(/^ARG .*(PASSWORD|SECRET|KEY|TOKEN)/im);
    expect(joined).not.toMatch(/^ENV .*(PASSWORD|SECRET|STRIPE|TOKEN)/im);
    expect(joined).not.toContain('PAYMENTS_MODE');
    expect(joined).not.toContain('dev-server');
    expect(joined).not.toContain('deterministic');
    // The RDS public trust anchor is baked in; the application still verifies the chain.
    expect(dockerfile).toContain('truststore.pki.rds.amazonaws.com/global/global-bundle.pem');
    expect(dockerfile).toContain('DATABASE_SSL_CA_FILE=/etc/himma/certs/rds-global-bundle.pem');
    for (const excluded of ['.env', 'test', '.git', 'scripts/dev-server.ts', 'scripts/dev-seed.ts', 'scripts/dev-hosted-checkout.ts', 'scripts/db-down.ts']) {
      expect(dockerignore.split('\n')).toContain(excluded);
    }
  });
});

describe('local container harness — production topology, no dev capability', () => {
  const compose = read('infra/local/docker-compose.yml');
  it('runs NODE_ENV=production with verify-full TLS to a non-loopback host, four separate DB identities, and never a dev/deterministic/live setting', () => {
    expect(compose).toContain('NODE_ENV: production');
    expect(compose).toContain('DATABASE_SSL_MODE: verify-full');
    expect(compose).toContain('PAYMENTS_MODE: disabled');
    // Mirrors the ECS task definitions: read-only root filesystem, no tmpfs.
    expect(compose).toMatch(/x-backend-image: &backend-image\n[\s\S]*?read_only: true/);
    expect(compose).not.toMatch(/^\s+tmpfs:/m);
    expect(compose).not.toMatch(/PAYMENTS_MODE:\s*live/);
    const composeConfig = compose.split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n');
    expect(composeConfig).not.toMatch(/DEV_|DevPassword|deterministic|fixture/i);
    for (const login of ['himma_owner', 'himma_api', 'himma_worker', 'himma_maintenance_runner']) {
      expect(compose).toContain(`postgres://${login}:`);
    }
    // maintenance is an explicit profile (never a resident service); api exposes the only port.
    expect(compose).toMatch(/maintenance:\n[\s\S]*?profiles: \[maintenance\]/);
    expect((compose.match(/^\s+ports:/gm) ?? []).length).toBe(1);
  });
});

describe('Terraform — network and database boundaries', () => {
  it('RDS is private, encrypted, TLS-forced, backed up, deletion-protected by variable, master password RDS-managed (no plaintext in state)', () => {
    const db = tfOf('modules/database');
    expect(db).toContain('publicly_accessible    = false');
    expect(db).toContain('storage_encrypted     = true');
    expect(db).toContain('manage_master_user_password   = true');
    expect(db).toMatch(/name\s+= "rds\.force_ssl"\s+value = "1"/);
    expect(db).toContain('backup_retention_period   = var.backup_retention_days');
    expect(db).toContain('deletion_protection       = var.deletion_protection');
    expect(db).not.toMatch(/password\s*=\s*"/);
  });

  it('database subnets have no internet route; the DB security group admits only api/worker/jobs; worker/jobs have no ingress rule', () => {
    const net = tfOf('modules/network');
    expect(net).toMatch(/resource "aws_route_table" "database"[\s\S]*?\n}/);
    expect(net).not.toMatch(/aws_route" "database/);
    expect(net).toMatch(/resource "aws_vpc_security_group_ingress_rule" "database_from_app"[\s\S]*?referenced_security_group_id = each\.value/);
    expect(net).not.toMatch(/ingress_rule" "worker/);
    expect(net).not.toMatch(/ingress_rule" "jobs/);
    // 0.0.0.0/0 appears exactly three times: ALB ingress 443, ALB ingress 80, and the ONE
    // for_each egress rule block (HTTPS out for api/worker/jobs). No other ingress is open.
    const open = net.match(/cidr_ipv4\s+= "0\.0\.0\.0\/0"/g) ?? [];
    expect(open.length).toBe(3);
    const ingressOpen = [...net.matchAll(/resource "aws_vpc_security_group_ingress_rule" "([a-z_]+)" \{[\s\S]*?\n\}/g)]
      .filter((m) => m[0].includes('0.0.0.0/0'))
      .map((m) => m[1]);
    expect(ingressOpen.sort()).toEqual(['alb_http_redirect', 'alb_https']);
  });

  it('the API is the only publicly reachable runtime: one ALB target group; the worker service has no load_balancer block; maintenance/migrate are run-task definitions, not services', () => {
    const compute = tfOf('modules/compute');
    expect(compute).toMatch(/resource "aws_ecs_service" "api"[\s\S]*?load_balancer \{/);
    const workerService = compute
      .slice(compute.indexOf('resource "aws_ecs_service" "worker"'), compute.indexOf('# ---- scheduled maintenance'))
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    expect(workerService).not.toContain('load_balancer');
    expect((compute.match(/resource "aws_ecs_service"/g) ?? []).length).toBe(2);
    expect(compute).toMatch(/aws_scheduler_schedule" "retention_all"/);
    expect(compute).toContain('"scripts/start-maintenance.ts", "retention.all"');
    expect(compute).not.toMatch(/start-maintenance\.ts", "(retention\.(audit|evidence|identity)|repair)/);
  });

  it('secret access is separated per task: each execution role reads only its own secrets; only the API task role gets evidence access; no long-lived access keys anywhere', () => {
    const compute = tfOf('modules/compute');
    expect(compute).toMatch(/resource "aws_iam_role" "execution" \{\n\s+for_each\s+= local\.roles/);
    expect(compute).toContain('resources = each.value.secret_read');
    expect(compute).toMatch(/secret_read\s+= compact\(\[var\.secret_arns\["db\/api"\]/);
    expect(compute).toMatch(/secret_read\s+= compact\(\[var\.secret_arns\["db\/worker"\]/);
    expect(compute).toMatch(/secret_read\s+= \[var\.secret_arns\["db\/maintenance"\]\]/);
    expect(compute).toMatch(/secret_read\s+= \[var\.rds_master_secret_arn/);
    // api/worker/maintenance never see the master secret.
    const roleBlock = (name: string): string => compute.slice(compute.indexOf(`    ${name} = {`), compute.indexOf('    }', compute.indexOf(`    ${name} = {`)));
    for (const role of ['api', 'worker', 'maintenance']) {
      expect(roleBlock(role)).not.toContain('rds_master_secret_arn');
    }
    expect(roleBlock('api')).not.toContain('db/worker');
    expect(roleBlock('worker')).not.toContain('db/api');
    expect(roleBlock('maintenance')).not.toContain('db/api');
    expect(compute).toMatch(/aws_iam_role_policy_attachment" "api_evidence"[\s\S]*?role\s+= aws_iam_role\.task\["api"\]\.name/);
    expect(tfAll).not.toContain('aws_iam_access_key');
    expect(tfAll).not.toContain('aws_iam_user');
  });

  it('payments: Terraform refuses anything but disabled|test; no live value exists anywhere in the infrastructure', () => {
    expect(tfAll).toMatch(/contains\(\["disabled", "test"\], var\.payments_mode\)/);
    expect(tfAll).not.toMatch(/PAYMENTS_MODE\s*=\s*"live"/);
    expect(tfAll).not.toMatch(/sk_live/);
    expect(stripComments(read('.github/workflows/deploy.yml'), '#')).not.toMatch(/live/i);
  });

  it('evidence and static buckets block all public access, encrypt, version, and deny insecure transport; evidence has no lifecycle expiry', () => {
    const evidence = tfOf('modules/evidence_bucket');
    expect(evidence).toContain('block_public_acls       = true');
    expect(evidence).toContain('restrict_public_buckets = true');
    expect(evidence).toContain('DenyInsecureTransport');
    expect(evidence).toMatch(/status = "Enabled"/);
    expect(evidence).not.toContain('aws_s3_bucket_lifecycle_configuration');
    expect(evidence).not.toContain('s3:DeleteObject');
    const site = tfOf('modules/static_site');
    expect(site).toContain('block_public_acls       = true');
    expect(site).toContain('origin_access_control_id');
    expect(site).toContain('viewer_protocol_policy     = "redirect-to-https"');
  });

  it('the stack pins the region to me-central-1 and the provider to the expected workload account; state is remote, encrypted, locked', () => {
    const stack = tfOf('stacks/himma');
    expect(stack).toMatch(/condition\s+= var\.region == "me-central-1"/);
    expect(stack).toContain('allowed_account_ids = [var.expected_account_id]');
    expect(stack).toContain('backend "s3" {}');
    expect(read('infra/terraform/envs/staging/backend.hcl.example')).toContain('use_lockfile = true');
    expect(read('infra/terraform/envs/production/backend.hcl.example')).toContain('encrypt      = true');
    const bootstrap = tfOf('bootstrap');
    expect(bootstrap).toContain('prevent_destroy = true');
    expect(bootstrap).toContain('block_public_acls       = true');
    expect(read('.gitignore')).toContain('*.tfstate');
  });

  it('Cognito: separate pool per environment, public clients without secrets, the certified auth flows only', () => {
    const cognito = tfOf('modules/cognito');
    expect(cognito).toContain('generate_secret = false');
    expect(cognito).toContain('"ALLOW_USER_PASSWORD_AUTH"');
    expect(cognito).toContain('"ALLOW_REFRESH_TOKEN_AUTH"');
    expect(cognito).not.toContain('identity_provider');
    expect(cognito).not.toContain('ALLOW_ADMIN_USER_PASSWORD_AUTH');
  });
});

describe('GitHub Actions — OIDC only, deploy-disabled without account variables, no production auto-deploy, no down migrations', () => {
  const ci = read('.github/workflows/ci.yml');
  const deploy = read('.github/workflows/deploy.yml');
  it('holds the invariants', () => {
    expect(deploy).toContain('id-token: write');
    expect(deploy).toContain('role-to-assume: ${{ vars.HIMMA_STAGING_DEPLOY_ROLE_ARN }}');
    expect(deploy).toContain('environment: production');
    expect(deploy).toMatch(/needs\.gate\.outputs\.production == 'true'/);
    expect(deploy).not.toMatch(/AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY/);
    expect(ci).not.toMatch(/AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|secrets\./);
    for (const text of [ci, deploy, read('infra/scripts/ecs-deploy.sh')].map((t) => stripComments(t, '#'))) {
      expect(text).not.toContain('db:down');
      expect(text).not.toContain('db-down');
    }
    expect(ci).toContain('npm audit --omit=dev --audit-level=high');
    expect(ci).toContain('aquasecurity/trivy-action');
    // Production deployment never happens on push: it needs the dispatch target + environment approval.
    expect(deploy).toMatch(/TARGET" == "production"[\s\S]*production=true/);
  });
});

describe('application production boundaries re-pinned', () => {
  it('productionChargingPossible stays the literal false; no live payments mode; TLS is fail-closed for non-loopback production hosts', () => {
    const composition = read('backend/src/modules/payment/provider-composition.ts');
    expect(composition).toMatch(/productionChargingPossible:\s*false/);
    const runtime = read('backend/src/config/runtime.ts');
    expect(runtime).toContain('There is no "live" value');
    const env = read('backend/src/config/env.ts');
    expect(env).toContain("DATABASE_SSL_MODE=disable is refused in production for the non-loopback database host");
    expect(env).not.toMatch(/rejectUnauthorized:\s*false/);
    expect(read('backend/src/db/connection-options.ts')).toContain('rejectUnauthorized: true');
    expect(read('backend/src/db/connection-options.ts')).not.toMatch(/rejectUnauthorized:\s*false/);
  });
});
