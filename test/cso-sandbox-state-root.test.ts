import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CsoError } from '../lib/cso/contracts';
import { privateRoot, sandboxStateRoot } from '../lib/cso/state';

// CHE-10265: inside a Codex workspace-write sandbox ~/.gstack is read-only, so the default state root cannot be
// created. The core retries once under a private per-uid directory in /tmp; the ancestor guard stays on.
const posix = process.platform !== 'win32' && process.getuid?.() !== 0;
const uid = process.getuid?.();
const made: string[] = [];
const scratch = (): string => {
  const dir = fs.mkdtempSync(path.join('/tmp', 'cso-sbx-'));
  made.push(dir);
  return dir;
};
/** A HOME whose ~/.gstack exists but cannot be written, as in the sandbox. */
const readOnlyHome = (): string => {
  const home = scratch();
  fs.mkdirSync(path.join(home, '.gstack'), { mode: 0o555 });
  fs.chmodSync(path.join(home, '.gstack'), 0o555);
  return home;
};
const failure = (fn: () => unknown): CsoError => {
  try {
    fn();
  } catch (error) {
    return error as CsoError;
  }
  throw new Error('expected a CsoError');
};
afterEach(() => {
  for (const dir of made.splice(0)) {
    try {
      for (const sub of fs.readdirSync(dir)) fs.chmodSync(path.join(dir, sub), 0o700);
    } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('sandbox fallback state root', () => {
  test.skipIf(!posix)('names a per-uid directory under the base', () => {
    expect(sandboxStateRoot('/base')).toBe(`/base/gstack-cso-${uid}`);
  });

  test.skipIf(!posix)('a read-only default root falls back to a private 0700 directory', () => {
    const home = readOnlyHome();
    const base = scratch();
    const root = privateRoot({ HOME: home }, base);
    expect(root).toBe(path.join(base, `gstack-cso-${uid}`, 'security', 'cso'));
    expect(fs.statSync(root).mode & 0o777).toBe(0o700);
    expect(fs.statSync(root).uid).toBe(uid!);
    expect(privateRoot({ HOME: home }, base)).toBe(root);
  });

  test.skipIf(!posix)('a writable default root is used and the fallback is not created', () => {
    const home = scratch();
    const base = scratch();
    expect(privateRoot({ HOME: home }, base)).toBe(path.join(home, '.gstack', 'security', 'cso'));
    expect(fs.readdirSync(base)).toEqual([]);
  });

  test.skipIf(!posix)('an explicit GSTACK_HOME that is not writable is reported, never replaced', () => {
    const home = readOnlyHome();
    const base = scratch();
    for (const name of ['GSTACK_STATE_ROOT', 'GSTACK_HOME', 'GSTACK_STATE_DIR'])
      expect(failure(() => privateRoot({ HOME: home, [name]: path.join(home, '.gstack') }, base))).toMatchObject({
        code: 'PERSISTENCE_FAILED',
      });
    expect(fs.readdirSync(base)).toEqual([]);
  });

  test.skipIf(!posix)('a group- or world-writable ancestor of the fallback is still rejected', () => {
    const home = readOnlyHome();
    const base = scratch();
    fs.chmodSync(base, 0o777);
    expect(failure(() => privateRoot({ HOME: home }, base))).toMatchObject({
      code: 'UNSAFE_PATH',
      message: 'Private state has a group- or world-writable ancestor',
    });
  });

  test.skipIf(!posix)('a group-writable pre-existing fallback leaf is still rejected', () => {
    const home = readOnlyHome();
    const base = scratch();
    const leaf = path.join(base, `gstack-cso-${uid}`);
    fs.mkdirSync(leaf);
    fs.chmodSync(leaf, 0o770);
    expect(failure(() => privateRoot({ HOME: home }, base))).toMatchObject({ code: 'UNSAFE_PATH' });
  });

  test.skipIf(!posix)('an unsafe default ancestor is rejected, not retried in the fallback', () => {
    const home = scratch();
    fs.mkdirSync(path.join(home, '.gstack'), { mode: 0o700 });
    fs.chmodSync(path.join(home, '.gstack'), 0o777);
    const base = scratch();
    expect(failure(() => privateRoot({ HOME: home }, base))).toMatchObject({ code: 'UNSAFE_PATH' });
    expect(fs.readdirSync(base)).toEqual([]);
  });
});

const bwrap = '/usr/bin/bwrap';
describe('fallback inside a read-only user namespace', () => {
  // Same shape as the Codex sandbox: everything read-only, a fresh sticky /tmp, HOME/.gstack read-only.
  test.skipIf(!posix || process.platform !== 'linux' || !fs.existsSync(bwrap) || !fs.existsSync('/var/tmp'))(
    'the default /tmp fallback succeeds under bwrap --unshare-user --ro-bind',
    () => {
      const work = fs.mkdtempSync(path.join('/var/tmp', 'cso-sbx-ns-'));
      made.push(work);
      try {
        fs.mkdirSync(path.join(work, 'home'), { mode: 0o700 });
        // The real sandbox case: the state directories already exist, on a read-only mount.
        fs.mkdirSync(path.join(work, 'home', '.gstack'), { mode: 0o700 });
        fs.mkdirSync(path.join(work, 'home', '.gstack', 'security'), { mode: 0o700 });
        fs.mkdirSync(path.join(work, 'home', '.gstack', 'security', 'cso'), { mode: 0o700 });
        const file = path.join(work, 'probe.ts');
        fs.writeFileSync(
          file,
          `import { privateRoot } from ${JSON.stringify(path.resolve(import.meta.dir, '../lib/cso/state.ts'))};
console.log(privateRoot({ HOME: ${JSON.stringify(path.join(work, 'home'))} }));`,
        );
        const r = spawnSync(
          bwrap,
          ['--unshare-user', '--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev', '--perms', '1777', '--tmpfs', '/tmp', process.execPath, file],
          { encoding: 'utf8', timeout: 60_000 },
        );
        expect(r.stderr).not.toContain('UNSAFE_PATH');
        expect(r.stdout.trim()).toMatch(/^\/tmp\/gstack-cso-\d+\/security\/cso$/);
        expect(r.status).toBe(0);
      } finally {
        fs.rmSync(work, { recursive: true, force: true });
      }
    },
  );
});
