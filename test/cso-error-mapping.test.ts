import { describe, expect, test } from 'bun:test';
import { unexpectedFailure } from '../lib/cso/cli';
import { CsoError } from '../lib/cso/contracts';
import { secureDirectory } from '../lib/cso/state';

// CHE-9982: a helper fault (unwritable state root) used to surface as INVALID_SCHEMA
// "The helper rejected an unexpected or unsafe input", which hid the cause.
describe('CSO helper fault reporting', () => {
  test('names filesystem faults instead of calling them a schema rejection', () => {
    const error = Object.assign(new Error("EACCES: permission denied, mkdir '/secret/path'"), { code: 'EACCES' });
    const mapped = unexpectedFailure(error);
    expect(mapped).toMatchObject({ code: 'PERSISTENCE_FAILED', message: 'The helper hit a filesystem error (EACCES)' });
    expect(mapped.message).not.toContain('/secret/path');
  });

  test('keeps the opaque label for an unknown exception', () => {
    for (const value of [new Error('boom'), 'text', null, { code: 'not-errno' }, { code: 42 }])
      expect(unexpectedFailure(value)).toMatchObject({
        code: 'INVALID_SCHEMA',
        message: 'The helper rejected an unexpected or unsafe input',
      });
  });

  test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'an unwritable state root reports PERSISTENCE_FAILED with the errno and a remedy',
    () => {
      let failure: unknown;
      try {
        secureDirectory('/proc/cso-state-che-9982');
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(CsoError);
      expect(failure).toMatchObject({ code: 'PERSISTENCE_FAILED' });
      expect((failure as CsoError).message).toMatch(/\((EACCES|ENOENT|EPERM|EROFS)\).*GSTACK_HOME/);
    },
  );
});
