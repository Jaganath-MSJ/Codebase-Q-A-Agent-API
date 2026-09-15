import { describe, it, expect } from 'vitest';
import { SourceAdapterRegistry } from './source-adapter.registry';
import type { LocalPathAdapter } from './local-path.adapter';
import type { GitUrlAdapter } from './git-url.adapter';
import type { ZipUploadAdapter } from './zip-upload.adapter';
import type { GitPrivateAdapter } from './git-private.adapter';

/**
 * QA pass — TC-SRC-2xx.
 *
 * Pure dispatch, but the failure mode matters: an unrecognised kind must throw
 * rather than fall through to a default adapter, since silently materialising
 * the wrong source kind would point the indexer at the wrong place entirely.
 */

const local = { kind: 'local_path' } as unknown as LocalPathAdapter;
const gitUrl = { kind: 'git_url' } as unknown as GitUrlAdapter;
const zip = { kind: 'zip_upload' } as unknown as ZipUploadAdapter;
const gitPrivate = { kind: 'git_private' } as unknown as GitPrivateAdapter;

const registry = new SourceAdapterRegistry(local, gitUrl, zip, gitPrivate);

describe('SourceAdapterRegistry', () => {
  describe('TC-SRC-200..203 — dispatch', () => {
    const cases = [
      ['TC-SRC-200', 'local_path', local],
      ['TC-SRC-201', 'git_url', gitUrl],
      ['TC-SRC-202', 'zip_upload', zip],
      ['TC-SRC-203', 'git_private', gitPrivate],
    ] as const;

    for (const [id, kind, expected] of cases) {
      it(`${id} returns the ${kind} adapter`, () => {
        expect(registry.getAdapter(kind)).toBe(expected);
      });
    }
  });

  describe('TC-SRC-210..214 — unknown kinds', () => {
    it('TC-SRC-210 throws for an unrecognised kind', () => {
      expect(() => registry.getAdapter('svn')).toThrow(
        /Source kind 'svn' is not implemented yet/,
      );
    });

    it('TC-SRC-211 throws for an empty kind', () => {
      expect(() => registry.getAdapter('')).toThrow(/not implemented yet/);
    });

    it('TC-SRC-212 is case sensitive', () => {
      // A silent fallthrough on "Local_Path" would materialise the wrong source.
      expect(() => registry.getAdapter('Local_Path')).toThrow();
      expect(() => registry.getAdapter('GIT_URL')).toThrow();
    });

    it('TC-SRC-213 does not match on a prefix or suffix', () => {
      expect(() => registry.getAdapter('local_path_evil')).toThrow();
      expect(() => registry.getAdapter('xlocal_path')).toThrow();
    });

    it('TC-SRC-214 is not confused by prototype-chain property names', () => {
      // `getAdapter` uses explicit comparisons rather than object lookup, so
      // these are just unknown strings. Pinned so a future refactor to a map
      // literal cannot reintroduce a prototype-pollution style lookup.
      for (const kind of [
        'constructor',
        '__proto__',
        'toString',
        'hasOwnProperty',
      ]) {
        expect(() => registry.getAdapter(kind), kind).toThrow(
          /not implemented yet/,
        );
      }
    });
  });

  it('TC-SRC-220 covers every kind the registry knows about', () => {
    // Guards against a new adapter being wired into the constructor without a
    // dispatch branch — it would be injected but permanently unreachable.
    const known = ['local_path', 'git_url', 'zip_upload', 'git_private'];
    const returned = known.map((kind) => registry.getAdapter(kind));
    expect(new Set(returned).size).toBe(known.length);
  });
});
