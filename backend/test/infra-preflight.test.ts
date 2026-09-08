/**
 * W6-4B — the Terraform apply preflight (`infra/scripts/tf-preflight.sh`)
 * is the hard gate before any real `terraform apply` (docs/38; owner
 * directive W6-4B §3). This suite runs the REAL script against a COPY of the
 * infra tree in a temporary directory with a stub `aws` executable on PATH,
 * so no credential, account, or network is involved and the operator's real
 * gitignored `terraform.tfvars` is never touched. It proves the refusal
 * matrix: missing var file · no CLI · no session · account mismatch · wrong
 * region · production without the explicit authorization · and the single
 * OK path. Never "fix" a mismatch by editing the expected id — the script
 * has no such path.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');
const STAGING_ID = '111111111111';
const OTHER_ID = '222222222222';

let work: string;
let infra: string;
let binDir: string;

function stubAws(mode: 'absent' | 'no-session' | { account: string }): string {
  const pathWithoutAws = process.env.PATH!.split(path.delimiter)
    .filter((p) => !p.includes('/opt/homebrew/bin') && !p.includes('/usr/local/bin'))
    .join(path.delimiter);
  if (mode === 'absent') return pathWithoutAws;
  const script =
    mode === 'no-session'
      ? '#!/bin/sh\necho "Unable to locate credentials" >&2\nexit 255\n'
      : `#!/bin/sh\nprintf '{"UserId":"AIDASTUB","Account":"${mode.account}","Arn":"arn:aws:sts::${mode.account}:assumed-role/himma-engineering/operator"}\\n'\n`;
  writeFileSync(path.join(binDir, 'aws'), script);
  chmodSync(path.join(binDir, 'aws'), 0o755);
  return `${binDir}${path.delimiter}${pathWithoutAws}`;
}

function tfvars(env: string, body: string): void {
  const dir = path.join(infra, 'terraform', 'envs', env);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'terraform.tfvars'), body);
}

function preflight(env: string, PATH: string, extra: NodeJS.ProcessEnv = {}) {
  const result = spawnSync('bash', [path.join(infra, 'scripts', 'tf-preflight.sh'), env], {
    env: { PATH, HOME: os.homedir(), ...extra },
    encoding: 'utf8',
  });
  return { code: result.status, out: `${result.stdout}\n${result.stderr}` };
}

beforeAll(() => {
  work = mkdtempSync(path.join(os.tmpdir(), 'himma-preflight-'));
  infra = path.join(work, 'infra');
  binDir = path.join(work, 'bin');
  mkdirSync(binDir);
  cpSync(path.join(ROOT, 'infra', 'scripts'), path.join(infra, 'scripts'), { recursive: true });
  mkdirSync(path.join(infra, 'terraform', 'envs'), { recursive: true });
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

const STAGING_VARS = `environment = "staging"\nexpected_account_id = "${STAGING_ID}"\nregion = "me-central-1"\n`;

describe('tf-preflight.sh — refuses everything except the exact staging identity', () => {
  it('refuses when the environment var file is missing (nothing to compare against)', () => {
    const r = preflight('staging', stubAws({ account: STAGING_ID }));
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/missing .*terraform\.tfvars/);
  });

  it('refuses a region other than me-central-1 in the var file before touching AWS', () => {
    tfvars('staging', `environment = "staging"\nexpected_account_id = "${STAGING_ID}"\nregion = "eu-west-1"\n`);
    const r = preflight('staging', stubAws({ account: STAGING_ID }), { AWS_REGION: 'me-central-1' });
    expect(r.code).toBe(3);
    expect(r.out).toMatch(/region must be me-central-1/);
  });

  it('refuses without an AWS CLI and without an authenticated session (exit 4 — nothing is applied)', () => {
    tfvars('staging', STAGING_VARS);
    const absent = preflight('staging', stubAws('absent'), { AWS_REGION: 'me-central-1' });
    expect(absent.code).toBe(4);
    expect(absent.out).toMatch(/aws CLI not found/);
    const noSession = preflight('staging', stubAws('no-session'), { AWS_REGION: 'me-central-1' });
    expect(noSession.code).toBe(4);
    expect(noSession.out).toMatch(/no authenticated AWS session/);
  });

  it('refuses an authenticated account that is not the configured staging account (never re-targets)', () => {
    tfvars('staging', STAGING_VARS);
    const r = preflight('staging', stubAws({ account: OTHER_ID }), { AWS_REGION: 'me-central-1' });
    expect(r.code).toBe(5);
    expect(r.out).toContain(`REFUSED: authenticated account ${OTHER_ID} != expected ${STAGING_ID}`);
    expect(r.out).not.toMatch(/preflight OK/);
  });

  it('refuses the right account in the wrong session region', () => {
    tfvars('staging', STAGING_VARS);
    const r = preflight('staging', stubAws({ account: STAGING_ID }), { AWS_REGION: 'eu-west-1' });
    expect(r.code).toBe(5);
    expect(r.out).toMatch(/AWS_REGION must be me-central-1/);
  });

  it('passes ONLY for the exact staging account in me-central-1, printing identity facts and never a secret', () => {
    tfvars('staging', STAGING_VARS);
    const r = preflight('staging', stubAws({ account: STAGING_ID }), { AWS_REGION: 'me-central-1' });
    expect(r.code).toBe(0);
    expect(r.out).toContain(`account id  : ${STAGING_ID}`);
    expect(r.out).toContain('region      : me-central-1');
    expect(r.out).toMatch(/preflight OK — you may run: terraform .* plan .*envs\/staging\/terraform\.tfvars/);
    expect(r.out).not.toMatch(/secret|password|AKIA/i);
  });

  it('refuses production even with the right account unless HIMMA_ALLOW_PRODUCTION_APPLY=yes (W6-4B is staging only)', () => {
    tfvars('production', `environment = "production"\nexpected_account_id = "${OTHER_ID}"\nregion = "me-central-1"\n`);
    const r = preflight('production', stubAws({ account: OTHER_ID }), { AWS_REGION: 'me-central-1' });
    expect(r.code).toBe(6);
    expect(r.out).toMatch(/REFUSED: production apply is not authorized/);
    // The staging account can never pass a production preflight either.
    const wrong = preflight('production', stubAws({ account: STAGING_ID }), {
      AWS_REGION: 'me-central-1',
      HIMMA_ALLOW_PRODUCTION_APPLY: 'yes',
    });
    expect(wrong.code).toBe(5);
  });
});
