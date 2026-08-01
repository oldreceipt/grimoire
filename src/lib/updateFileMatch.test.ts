import { describe, expect, it } from 'vitest';
import type { GameBananaFile } from '../types/gamebanana';
import { resolveUpdateTarget } from './updateFileMatch';

function file(
  id: number,
  fileName: string,
  description = '',
  isArchived = false,
): GameBananaFile {
  return {
    id,
    fileName,
    description,
    isArchived,
    fileSize: 128,
    downloadUrl: `https://fixtures.invalid/${fileName}`,
    downloadCount: 0,
  };
}

describe('resolveUpdateTarget', () => {
  it('uses a unique author description to resolve a replacement', () => {
    const files = [
      file(10, 'old_gold.zip', 'Gold', true),
      file(11, 'new_gold.zip', 'Gold'),
      file(12, 'new_silver.zip', 'Silver'),
    ];

    expect(resolveUpdateTarget({ installedFileId: 10 }, files)?.id).toBe(11);
  });

  it('uses distinctive filename tokens when the description changed', () => {
    const files = [
      file(10, 'galaxy_rem_gold_v1_2025.zip', '', true),
      file(11, 'galaxy_rem_gold_v2_2026.zip'),
      file(12, 'galaxy_rem_silver_v2_2026.zip'),
    ];

    expect(resolveUpdateTarget({ installedFileId: 10 }, files)?.id).toBe(11);
  });

  it('does not guess when two current files match the same variant signals', () => {
    const files = [
      file(10, 'legacy.zip', 'Default', true),
      file(11, 'replacement-a.zip', 'Default'),
      file(12, 'replacement-b.zip', 'Default'),
    ];

    expect(
      resolveUpdateTarget(
        { installedFileId: 10, fileDescription: 'Default', sourceFileName: 'legacy.zip' },
        files,
      ),
    ).toBeNull();
  });

  it('does not select a near-tied filename candidate', () => {
    const files = [
      file(10, 'hero_blue_alt.zip', '', true),
      file(11, 'hero_blue.zip'),
      file(12, 'hero_alt.zip'),
    ];

    expect(resolveUpdateTarget({ installedFileId: 10 }, files)).toBeNull();
  });

  it('respects candidate ids already claimed by sibling variants', () => {
    const files = [
      file(10, 'old_gold.zip', 'Gold', true),
      file(11, 'new_gold.zip', 'Gold'),
      file(12, 'alternate_gold.zip', 'Gold'),
    ];

    expect(
      resolveUpdateTarget(
        { installedFileId: 10, fileDescription: 'Gold' },
        files,
        new Set([11]),
      )?.id,
    ).toBe(12);
  });

  it('returns null when no current candidate exists', () => {
    expect(resolveUpdateTarget({ installedFileId: 10 }, [file(10, 'old.zip', '', true)])).toBeNull();
  });
});
