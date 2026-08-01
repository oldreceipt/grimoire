/** Stable, renderer-visible phases for an installed-mod replacement. */
export type ModUpdatePhase =
  | 'preparing'
  | 'downloading'
  | 'installing'
  | 'updated'
  | 'failed'
  | 'cancelled'
  | 'needs-choice';

/** Terminal result returned by the main-process update transaction. */
export type ModUpdateOutcome = 'completed' | 'failed' | 'cancelled' | 'needs-choice';

/** The installed file information needed to preserve identity and state. */
export interface ModUpdateSource {
  id: string;
  metaKey: string;
  fileName: string;
  gameBananaId?: number;
  gameBananaFileId?: number;
  sha256?: string;
  size?: number;
  installedAt?: string;
  enabled: boolean;
  priority: number;
  vpkIndex?: number;
  variantLabel?: string;
}

export interface ModUpdateRequest {
  operationId: string;
  /** Card identity which does not change when local filenames/ids do. */
  stableKey: string;
  displayName: string;
  gameBananaId: number;
  fileId: number;
  fileName: string;
  section: string;
  categoryId?: number;
  sources: ModUpdateSource[];
}

export interface ModUpdateReplacement {
  id: string;
  metaKey: string;
  fileName: string;
  gameBananaFileId?: number;
  sha256?: string;
  enabled: boolean;
  variantLabel?: string;
}

export interface ModUpdateResult {
  operationId: string;
  stableKey: string;
  status: ModUpdateOutcome;
  replacements?: ModUpdateReplacement[];
  error?: string;
}

export interface ModUpdateProgress {
  operationId: string;
  stableKey: string;
  phase: ModUpdatePhase;
  displayName: string;
  gameBananaId: number;
  fileId: number;
  downloaded?: number;
  total?: number;
  message?: string;
}

export interface ModUpdateBatchProgress {
  total: number;
  attempted: number;
  completed: number;
  failed: number;
  cancelled: number;
  needsChoice: number;
}

export type ModUpdateHarnessScenario =
  | 'update-available'
  | 'preparing'
  | 'slow'
  | 'paused'
  | 'downloading'
  | 'failed'
  | 'network'
  | '404'
  | 'cancelled'
  | 'corrupt'
  | 'extraction'
  | 'ambiguous'
  | 'multi-vpk'
  | 'success'
  | 'updated'
  | 'mixed';
