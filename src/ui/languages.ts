export type PURL_Type = 'npm' | 'pypi' | 'golang';
/**
 * Mapping of LSP language IDs to PURL types.
 */
export const SUPPORTED_LSP_LANGUAGE_IDS = {
    javascript: 'npm',
    javascriptreact: 'npm',
    typescript: 'npm',
    typescriptreact: 'npm',
    'pip-requirements': 'pip-requirements',
    python: 'pypi',
    go: 'golang'
} as const satisfies Record<string, PURL_Type>

export const isSupportedLSPLanguageId = (lang: string): lang is keyof typeof SUPPORTED_LSP_LANGUAGE_IDS => {
    return Object.prototype.hasOwnProperty.call(SUPPORTED_LSP_LANGUAGE_IDS, lang);
}
