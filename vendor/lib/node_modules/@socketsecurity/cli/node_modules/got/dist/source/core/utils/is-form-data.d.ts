/// <reference types="node" resolution-mode="require"/>
import type { Readable } from 'node:stream';
declare type FormData = {
    getBoundary: () => string;
    getLength: (callback: (error: Error | null, length: number) => void) => void;
} & Readable;
export default function isFormData(body: unknown): body is FormData;
export {};
