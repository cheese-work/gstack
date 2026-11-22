import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { unmappedRootInUserNamespace } from '../lib/cso/state';

const INITIAL_MAP = '         0          0 4294967295\n';
const USERNS_MAP = '         0       1000          1\n';
const linuxOnly = process.platform === 'linux';

describe('unmappedRootInUserNamespace', () => {
  test.skipIf(!linuxOnly)('accepts uid 65534 when uid_map is not the initial identity map', () => {
    expect(unmappedRootInUserNamespace(65534, () => USERNS_MAP)).toBe(true);
  });
  test.skipIf(!linuxOnly)('rejects uid 65534 when uid_map is the initial map', () => {
    expect(unmappedRootInUserNamespace(65534, () => INITIAL_MAP)).toBe(false);
    expect(unmappedRootInUserNamespace(65534, () => '0 0 4294967295')).toBe(false);
  });
  test('rejects every other uid regardless of the map', () => {
    for (const uid of [0, 1, 1000, 65533, 65535]) expect(unmappedRootInUserNamespace(uid, () => USERNS_MAP)).toBe(false);
  });
  test.skipIf(!linuxOnly)('rejects when uid_map cannot be read', () => {
    expect(unmappedRootInUserNamespace(65534, () => { throw new Error('ENOENT'); })).toBe(false);
  });
  test.skipIf(linuxOnly)('rejects off Linux', () => {
    expect(unmappedRootInUserNamespace(65534, () => USERNS_MAP)).toBe(false);
  });
});

const bwrap = '/usr/bin/bwrap';
describe('ensureDirectory inside a user namespace', () => {
  // /var and /var/tmp are host root-owned (sticky 1777), so they stat as uid 65534 in the namespace; the writable-ancestor check stays satisfied.
  test.skipIf(!linuxOnly || !fs.existsSync(bwrap) || !fs.existsSync('/var/tmp'))('secureDirectory succeeds under bwrap --unshare-user', () => {
    const home = fs.mkdtempSync(path.join('/var/tmp', 'cso-userns-'));
    try {
      const script = `import { secureDirectory } from ${JSON.stringify(path.resolve(import.meta.dir, '../lib/cso/state.ts'))};
secureDirectory(${JSON.stringify(path.join(home, 'a', 'b'))}); console.log('OK');`;
      const file = path.join(home, 'probe.ts');
      fs.writeFileSync(file, script);
      const r = spawnSync(bwrap, ['--unshare-user', '--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev', '--bind', home, home, process.execPath, file], { encoding: 'utf8', timeout: 60_000 });
      expect(r.stderr).not.toContain('UNSAFE_PATH');
      expect(r.stdout).toContain('OK');
      expect(r.status).toBe(0);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });
});
