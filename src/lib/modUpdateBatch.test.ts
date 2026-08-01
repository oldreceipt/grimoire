import { describe, expect, it } from 'vitest';
import type { ModUpdateRequest, ModUpdateResult } from '../types/modUpdate';
import { countModUpdateResult, initialModUpdateBatch, progressForResult } from './modUpdateBatch';

const request: ModUpdateRequest = {
  operationId: 'op-1',
  stableKey: 'gamebanana:42',
  displayName: 'Fixture Mod',
  gameBananaId: 42,
  fileId: 99,
  fileName: 'replacement.zip',
  section: 'Mods',
  sources: [
    {
      id: 'old-local-id',
      metaKey: 'pak01_dir.vpk',
      fileName: 'pak01_dir.vpk',
      gameBananaFileId: 98,
      enabled: true,
      priority: 1,
    },
  ],
};

function result(status: ModUpdateResult['status'], error?: string): ModUpdateResult {
  return { operationId: request.operationId, stableKey: request.stableKey, status, error };
}

describe('mod update batch accounting', () => {
  it('counts successful completion separately from attempts and failures', () => {
    let batch = initialModUpdateBatch(4);
    batch = countModUpdateResult(batch, result('completed'));
    batch = countModUpdateResult(batch, result('failed'));
    batch = countModUpdateResult(batch, result('cancelled'));
    batch = countModUpdateResult(batch, result('needs-choice'));

    expect(batch).toEqual({
      total: 4,
      attempted: 4,
      completed: 1,
      failed: 1,
      cancelled: 1,
      needsChoice: 1,
    });
  });

  it('does not mutate the previous batch object', () => {
    const before = initialModUpdateBatch(2);
    const after = countModUpdateResult(before, result('failed'));
    expect(before).toEqual({ total: 2, attempted: 0, completed: 0, failed: 0, cancelled: 0, needsChoice: 0 });
    expect(after).not.toBe(before);
  });

  it.each([
    ['completed', 'updated'],
    ['failed', 'failed'],
    ['cancelled', 'cancelled'],
    ['needs-choice', 'needs-choice'],
  ] as const)('maps terminal %s results to the %s card phase', (status, phase) => {
    expect(progressForResult(request, result(status, 'fixture message'))).toMatchObject({
      operationId: request.operationId,
      stableKey: request.stableKey,
      phase,
      displayName: request.displayName,
      message: 'fixture message',
      request,
    });
  });

  it('retains the original request for deterministic retry after failure', () => {
    const failed = progressForResult(request, result('failed', 'HTTP 404'));
    expect(failed.request).toBe(request);
    expect(failed.request.sources[0].id).toBe('old-local-id');
  });
});
