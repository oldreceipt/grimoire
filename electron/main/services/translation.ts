import { z } from 'zod';
import { getSessionToken } from './social';
import type {
    TranslationCatalogResponse,
    TranslationContributorResponse,
    TranslationProgressResponse,
    TranslationSuggestionRequest,
    TranslationSuggestionResponse,
} from '../../../src/types/translation';

const DEFAULT_BASE_URL = 'https://translate.grimoiremods.com';
const TRANSLATE_BASE_URL =
    process.env['GRIMOIRE_TRANSLATE_BASE_URL']?.replace(/\/+$/, '') || DEFAULT_BASE_URL;
const DEFAULT_TIMEOUT_MS = 15000;

const TranslationCatalogResponseSchema = z.object({
    languageCode: z.string(),
    rows: z.array(
        z.object({
            key: z.string(),
            source: z.string(),
            value: z.string(),
            status: z.enum(['missing', 'shipped', 'draft', 'translated', 'reviewed']),
            placeholders: z.array(z.string()),
            missingPlaceholders: z.array(z.string()),
            extraPlaceholders: z.array(z.string()),
        })
    ),
    stats: z.object({
        total: z.number(),
        completed: z.number(),
        reviewed: z.number(),
        drafts: z.number(),
    }),
});

const TranslationProgressResponseSchema = z.object({
    languageCode: z.string(),
    total: z.number(),
    completed: z.number(),
    reviewed: z.number(),
    pendingSuggestions: z.number(),
});

const TranslationSuggestionResponseSchema = z.object({
    suggestion: z.object({
        id: z.string(),
        languageCode: z.string(),
        key: z.string(),
        value: z.string(),
        status: z.enum(['pending', 'accepted', 'rejected']),
        createdAt: z.string(),
    }),
});

const TranslationContributorResponseSchema = z.object({
    contributor: z.object({
        id: z.string(),
        displayName: z.string(),
        avatarUrl: z.string().nullable(),
        role: z.enum(['translator', 'reviewer', 'admin']),
        trustLevel: z.number(),
        lastSeenAt: z.string(),
    }),
});

class TranslationApiError extends Error {
    readonly status: number;
    readonly issues?: unknown;

    constructor(message: string, status: number, issues?: unknown) {
        super(message);
        this.name = 'TranslationApiError';
        this.status = status;
        this.issues = issues;
    }
}

function buildUrl(path: string, query?: Record<string, string | undefined>): string {
    const url = new URL(`${TRANSLATE_BASE_URL}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
        if (value !== undefined) url.searchParams.set(key, value);
    }
    return url.toString();
}

async function request<T>(
    path: string,
    schema: z.ZodType<T>,
    options: {
        method?: 'GET' | 'POST';
        body?: unknown;
        query?: Record<string, string | undefined>;
        timeoutMs?: number;
    } = {}
): Promise<T> {
    const token = getSessionToken();
    if (!token) throw new TranslationApiError('Sign in with Steam before using Translation Mode', 401);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    let response: Response;
    try {
        response = await fetch(buildUrl(path, options.query), {
            method: options.method ?? 'GET',
            headers: {
                Accept: 'application/json',
                Authorization: `Bearer ${token}`,
                ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
            },
            body: options.body === undefined ? undefined : JSON.stringify(options.body),
            signal: controller.signal,
        });
    } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
            throw new TranslationApiError('Translation request timed out', 0);
        }
        throw new TranslationApiError(
            `Translation request failed: ${err instanceof Error ? err.message : String(err)}`,
            0
        );
    } finally {
        clearTimeout(timeoutId);
    }

    const text = await response.text();
    const body = text ? safeJson(text) : null;

    if (!response.ok) {
        const message =
            body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
                ? body.error
                : response.statusText;
        throw new TranslationApiError(message || 'Translation service error', response.status, body);
    }

    const parsed = schema.safeParse(body);
    if (!parsed.success) {
        throw new TranslationApiError(
            'Translation service returned an unexpected response shape',
            response.status,
            parsed.error.flatten()
        );
    }

    return parsed.data;
}

function safeJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

export async function getTranslationCatalog(languageCode: string): Promise<TranslationCatalogResponse> {
    return request('/api/live/catalog', TranslationCatalogResponseSchema, {
        query: { lang: languageCode },
    });
}

export async function getTranslationProgress(languageCode: string): Promise<TranslationProgressResponse> {
    return request('/api/live/progress', TranslationProgressResponseSchema, {
        query: { lang: languageCode },
    });
}

export async function saveTranslationSuggestion(
    body: TranslationSuggestionRequest
): Promise<TranslationSuggestionResponse> {
    return request('/api/live/suggestions', TranslationSuggestionResponseSchema, {
        method: 'POST',
        body,
    });
}

export async function registerTranslationContributor(): Promise<TranslationContributorResponse> {
    return request('/api/live/contributors/me', TranslationContributorResponseSchema);
}
