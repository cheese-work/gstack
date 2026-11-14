/**
 * CHE-5564: the fork updates from cheese-work/gstack without a prompt and
 * ships with telemetry hard off.
 *
 *  1. bin/gstack-update-check reads versions only from cheese-work/gstack
 *     (curl and git are shimmed on PATH; the request log must hold no garrytan URL).
 *  2. bin/gstack-skill-start on a fresh state root, with a newer fork version
 *     available, upgrades silently (bin/gstack-upgrade runs) and emits no
 *     upgrade-flow or telemetry-prompt block.
 *  3. No committed SKILL.md carries the "Telemetry (run last)" section or
 *     gstack-telemetry-log.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('gstack-update-check queries only the fork', () => {
  test('curl and git requests name cheese-work/gstack, never garrytan', () => {
    const dir = tmp('gstack-fork-upd-');
    const install = path.join(dir, 'install');
    const state = path.join(dir, 'state');
    const shim = path.join(dir, 'shim');
    const log = path.join(dir, 'requests.log');
    fs.mkdirSync(path.join(install, 'bin'), { recursive: true });
    fs.mkdirSync(state);
    fs.mkdirSync(shim);
    for (const n of ['gstack-config', 'gstack-egress-lib.sh', 'gstack-state-root.sh', 'gstack-egress-receipt', 'gstack-update-channel.sh']) {
      fs.symlinkSync(path.join(ROOT, 'bin', n), path.join(install, 'bin', n));
    }
    fs.writeFileSync(path.join(install, 'VERSION'), '1.0.0\n');
    fs.writeFileSync(path.join(shim, 'curl'), `#!/usr/bin/env bash\necho "curl $*" >> "${log}"\necho 1.0.1\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(shim, 'git'), `#!/usr/bin/env bash\necho "git $*" >> "${log}"\nexit 0\n`, { mode: 0o755 });
    try {
      const r = spawnSync('bash', [path.join(ROOT, 'bin', 'gstack-update-check'), '--force'], {
        encoding: 'utf8',
        timeout: 30_000,
        env: { PATH: `${shim}:${process.env.PATH}`, HOME: dir, GSTACK_DIR: install, GSTACK_HOME: state },
      });
      const requests = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
      expect(requests, r.stdout + r.stderr).toContain('cheese-work/gstack');
      expect(requests).not.toContain('garrytan');
      expect(r.stdout).toContain('UPGRADE_AVAILABLE 1.0.0 1.0.1');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('gstack-update-check sends no telemetry ping', () => {
  test('no request to Supabase even with telemetry: community and a Supabase URL configured', () => {
    const dir = tmp('gstack-fork-ping-');
    const install = path.join(dir, 'install');
    const state = path.join(dir, 'state');
    const shim = path.join(dir, 'shim');
    const log = path.join(dir, 'requests.log');
    fs.mkdirSync(path.join(install, 'bin'), { recursive: true });
    fs.mkdirSync(state);
    fs.mkdirSync(shim);
    for (const n of ['gstack-config', 'gstack-egress-lib.sh', 'gstack-state-root.sh', 'gstack-egress-receipt', 'gstack-update-channel.sh']) {
      fs.symlinkSync(path.join(ROOT, 'bin', n), path.join(install, 'bin', n));
    }
    fs.writeFileSync(path.join(install, 'VERSION'), '1.0.0\n');
    fs.writeFileSync(path.join(state, 'config.yaml'), 'telemetry: community\n');
    fs.writeFileSync(path.join(shim, 'curl'), `#!/usr/bin/env bash\necho "curl $*" >> "${log}"\necho 1.0.1\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(shim, 'git'), `#!/usr/bin/env bash\necho "git $*" >> "${log}"\nexit 0\n`, { mode: 0o755 });
    try {
      const r = spawnSync('bash', [path.join(ROOT, 'bin', 'gstack-update-check'), '--force'], {
        encoding: 'utf8',
        timeout: 30_000,
        env: {
          PATH: `${shim}:${process.env.PATH}`, HOME: dir, GSTACK_DIR: install, GSTACK_HOME: state,
          GSTACK_SUPABASE_URL: 'https://example.supabase.co', GSTACK_SUPABASE_ANON_KEY: 'k',
        },
      });
      Bun.sleepSync(1000); // the old ping ran in a background subshell
      const requests = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
      expect(requests, r.stdout + r.stderr).toContain('cheese-work/gstack');
      expect(requests).not.toContain('supabase');
      expect(requests).not.toContain('update-check');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('gstack-skill-start: silent fork upgrade, no telemetry prompt', () => {
  function runFresh(lakeSeen: boolean): { out: string; upgradeCalls: string } {
    const dir = tmp('gstack-fork-start-');
    const home = path.join(dir, 'home');
    const state = path.join(dir, 'state'); // fresh state root: no config.yaml
    fs.mkdirSync(home);
    fs.mkdirSync(state);
    if (lakeSeen) fs.writeFileSync(path.join(state, '.completeness-intro-seen'), '');
    const bin = path.join(dir, 'bin');
    fs.cpSync(path.join(ROOT, 'bin'), bin, { recursive: true, dereference: false });
    fs.writeFileSync(path.join(bin, 'gstack-update-check'), '#!/usr/bin/env bash\necho "UPGRADE_AVAILABLE 1.0.0 1.0.1"\n', { mode: 0o755 });
    const calls = path.join(dir, 'upgrade-calls');
    fs.writeFileSync(path.join(bin, 'gstack-upgrade'), `#!/usr/bin/env bash\necho "called $*" >> "${calls}"\necho "gstack-upgrade: upgraded 1.0.0 -> 1.0.1"\n`, { mode: 0o755 });
    try {
      const out = execFileSync(path.join(bin, 'gstack-skill-start'), ['--skill', 'testskill'], {
        encoding: 'utf8',
        timeout: 60_000,
        cwd: home,
        env: { PATH: process.env.PATH!, HOME: home, GSTACK_HOME: state, GSTACK_LEASE_DIR: path.join(state, 'leases') },
      });
      return { out, upgradeCalls: fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '' };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  for (const lakeSeen of [false, true]) {
    test(`newer fork version installs silently (lake intro seen: ${lakeSeen})`, () => {
      const { out, upgradeCalls } = runFresh(lakeSeen);
      expect(upgradeCalls).toContain('called');
      expect(out).not.toContain('GSTACK_INSTRUCTION_BEGIN: upgrade-flow');
      expect(out).not.toContain('AskUserQuestion with 4 options');
      expect(out).not.toContain('GSTACK_INSTRUCTION_BEGIN: telemetry-prompt');
      expect(out).toMatch(/^TELEMETRY: off$/m);
    });
  }
});

describe('telemetry is hard off', () => {
  test('gstack-telemetry-log writes nothing and gstack-telemetry-sync sends nothing, even with telemetry: community', () => {
    const dir = tmp('gstack-fork-tel-');
    const shim = path.join(dir, 'shim');
    const log = path.join(dir, 'curl.log');
    fs.mkdirSync(shim);
    fs.writeFileSync(path.join(shim, 'curl'), `#!/usr/bin/env bash\necho "curl $*" >> "${log}"\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'config.yaml'), 'telemetry: community\n');
    const env = { PATH: `${shim}:${process.env.PATH}`, HOME: dir, GSTACK_HOME: dir };
    try {
      for (const args of [['telemetry-log', '--skill', 'x', '--outcome', 'success'], ['telemetry-sync']]) {
        const r = spawnSync('bash', [path.join(ROOT, 'bin', 'gstack-' + args[0]), ...args.slice(1)], { encoding: 'utf8', timeout: 30_000, env });
        expect(r.status, r.stderr).toBe(0);
      }
      expect(fs.existsSync(path.join(dir, 'analytics', 'skill-usage.jsonl'))).toBe(false);
      expect(fs.existsSync(log)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('generated skills carry no telemetry section', () => {
  test('no SKILL.md contains "Telemetry (run last)" or gstack-telemetry-log', () => {
    const files = execFileSync('git', ['ls-files', '--', '*SKILL.md', '*SKILL.md.tmpl'], { cwd: ROOT, encoding: 'utf8', timeout: 30_000 })
      .split('\n')
      .filter((f) => f && !f.startsWith('test/fixtures/'));
    expect(files.length).toBeGreaterThan(50);
    const offenders = files.filter((f) => {
      const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
      return text.includes('Telemetry (run last)') || text.includes('gstack-telemetry-log');
    });
    expect(offenders).toEqual([]);
  });
});
