/**
 * Fork-only tripwire (cheese-work/gstack, CHE-5029) for
 * .github/workflows/fork-free-suite.yml: the free suite on GitHub-hosted
 * runners, because upstream's free-tests.yml needs paid Ubicloud runners the
 * fork does not have.
 *
 *   1. No job of the fork workflow uses a ubicloud label (it would queue forever).
 *   2. It is secretless and triggers on pull_request, never pull_request_target.
 *   3. Its free-suite shard steps equal upstream's free-tests.yml free-suite
 *      steps. If this fails after an upstream sync, mirror the changed step
 *      from free-tests.yml into fork-free-suite.yml.
 *   4. It runs strict verification (--ci-verify) in an aggregate job.
 */
import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const DIR = path.resolve(import.meta.dir, '..', '.github', 'workflows');
const FORK = path.join(DIR, 'fork-free-suite.yml');
const UPSTREAM = path.join(DIR, 'free-tests.yml');

describe('fork free-suite workflow', () => {
  test('workflow file exists', () => {
    expect(fs.existsSync(FORK)).toBe(true);
  });
  if (!fs.existsSync(FORK)) return;

  const source = fs.readFileSync(FORK, 'utf-8');
  const fork = Bun.YAML.parse(source) as any;
  const upstream = Bun.YAML.parse(fs.readFileSync(UPSTREAM, 'utf-8')) as any;

  test('no job runs on a Ubicloud runner', () => {
    for (const [name, job] of Object.entries<any>(fork.jobs)) {
      expect(String(job['runs-on']), name).toBe('ubuntu-24.04');
    }
    expect(source.replace(/^\s*#.*$/gm, '')).not.toMatch(/ubicloud/);
  });

  test('secretless and pull_request only', () => {
    expect(source).not.toMatch(/secrets\./);
    expect(source).not.toContain('pull_request_target');
    expect(fork.on.pull_request).toBeDefined();
  });

  test('free-suite steps mirror upstream free-tests.yml', () => {
    expect(fork.jobs['free-suite'].steps).toEqual(upstream.jobs['free-suite'].steps);
    expect(fork.jobs['free-suite'].strategy).toEqual(upstream.jobs['free-suite'].strategy);
    expect(fork.jobs['free-suite']['timeout-minutes']).toBe(upstream.jobs['free-suite']['timeout-minutes']);
  });

  test('plan job keeps upstream seed ratchet with full history', () => {
    const steps = (job: any) => job.steps as any[];
    const ratchet = (wf: any) =>
      steps(wf.jobs['free-plan']).find((s) => s.name === 'Seed growth ratchet (60 s ceiling, shrink-only allowlist)');
    const checkout = (wf: any) => steps(wf.jobs['free-plan']).find((s) => String(s.uses).startsWith('actions/checkout@'));
    expect(ratchet(fork)).toEqual(ratchet(upstream));
    expect(ratchet(fork).run).toContain('GSTACK_FREE_SEED_BASE="$(git merge-base HEAD origin/main)"');
    expect(checkout(fork).with['fetch-depth']).toBe(0);
    expect(checkout(fork).with.filter).toBe('blob:none');
    // The ratchet runs after the plan step, before the plan artifact upload.
    const names = steps(fork.jobs['free-plan']).map((s) => s.name ?? s.uses);
    expect(names.indexOf(ratchet(fork).name)).toBeGreaterThan(names.indexOf('Inventory and balance the complete free suite'));
  });

  test('aggregate requires the suite and strict verification', () => {
    const agg = fork.jobs['free-tests-fork'];
    expect(agg.needs).toContain('free-suite');
    expect(agg.if).toBe('always()');
    expect(JSON.stringify(agg.steps)).toContain('--ci-verify');
  });
});
