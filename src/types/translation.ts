export type TranslationRowStatus = 'missing' | 'shipped' | 'draft' | 'translated' | 'reviewed';

export interface TranslationCatalogRow {
  key: string;
  source: string;
  value: string;
  status: TranslationRowStatus;
  placeholders: string[];
  missingPlaceholders: string[];
  extraPlaceholders: string[];
}

export interface TranslationCatalogResponse {
  languageCode: string;
  rows: TranslationCatalogRow[];
  stats: {
    total: number;
    completed: number;
    reviewed: number;
    drafts: number;
  };
}

export interface TranslationProgressResponse {
  languageCode: string;
  total: number;
  completed: number;
  reviewed: number;
  pendingSuggestions: number;
}

export interface TranslationSuggestionRequest {
  languageCode: string;
  key: string;
  value: string;
  source: string;
  contextRoute?: string;
  appVersion?: string;
}

export interface TranslationSuggestionResponse {
  suggestion: {
    id: string;
    languageCode: string;
    key: string;
    value: string;
    status: 'pending' | 'accepted' | 'rejected';
    createdAt: string;
  };
}

export interface TranslationContributorResponse {
  contributor: {
    id: string;
    displayName: string;
    avatarUrl: string | null;
    role: 'translator' | 'reviewer' | 'admin';
    trustLevel: number;
    lastSeenAt: string;
  };
}
