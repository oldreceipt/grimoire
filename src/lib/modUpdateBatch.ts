import type {
  ModUpdateBatchProgress,
  ModUpdateProgress,
  ModUpdateRequest,
  ModUpdateResult,
} from '../types/modUpdate';

export interface ModUpdateCardState extends ModUpdateProgress {
  request: ModUpdateRequest;
}

export function initialModUpdateBatch(total: number): ModUpdateBatchProgress {
  return { total, attempted: 0, completed: 0, failed: 0, cancelled: 0, needsChoice: 0 };
}

/** Counts terminal outcomes, never conflating attempts with success. */
export function countModUpdateResult(
  batch: ModUpdateBatchProgress,
  result: ModUpdateResult,
): ModUpdateBatchProgress {
  const next = { ...batch, attempted: batch.attempted + 1 };
  if (result.status === 'completed') next.completed += 1;
  else if (result.status === 'failed') next.failed += 1;
  else if (result.status === 'cancelled') next.cancelled += 1;
  else next.needsChoice += 1;
  return next;
}

export function progressForResult(
  request: ModUpdateRequest,
  result: ModUpdateResult,
): ModUpdateCardState {
  const phase = result.status === 'completed' ? 'updated' : result.status;
  return {
    request,
    operationId: result.operationId,
    stableKey: result.stableKey,
    phase,
    displayName: request.displayName,
    gameBananaId: request.gameBananaId,
    fileId: request.fileId,
    message: result.error,
  };
}
