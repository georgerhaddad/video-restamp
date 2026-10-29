// PLACEHOLDER: the core implementation replaces this file. Signatures must not change.
import type { Analysis, RestampResult } from './types';

export type * from './types';

export function analyze(_data: Uint8Array): Analysis {
	throw new Error('not implemented');
}

export function restamp(_data: Uint8Array): RestampResult {
	throw new Error('not implemented');
}
