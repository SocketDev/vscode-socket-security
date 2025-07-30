import { json } from 'stream/consumers'

export type PURL_Type = 'npm' | 'pypi' | 'golang';
/**
 * Mapping of lsp language id to what kind of parsing to be done
 * These should be filtered down by file path etc for the generic ones like json
 */
export const SUPPORTED_LSP_LANGUAGE_IDS_TO_PARSER = {
    javascript: 'npm',
    javascriptreact: 'npm',
    typescript: 'npm',
    typescriptreact: 'npm',
    'pip-requirements': 'pip-requirements',
    python: 'pypi',
    go: 'golang',
    json: 'json',
    yaml: 'yaml',
    toml: 'toml'
} as const;

export const isSupportedLSPLanguageId = (lang: string): lang is keyof typeof SUPPORTED_LSP_LANGUAGE_IDS_TO_PARSER => {
    return Object.prototype.hasOwnProperty.call(SUPPORTED_LSP_LANGUAGE_IDS_TO_PARSER, lang);
}
