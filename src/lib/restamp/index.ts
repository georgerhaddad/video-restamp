// Fixes MP4/MOV files whose timestamps are stretched (seen on TikTok uploads: 60 fps
// footage labelled 30 fps, AAC packets claiming twice their real duration), by rewriting
// the moov sample tables. Header-only: nothing is decoded or re-encoded, and the media
// data stays byte-for-byte where it was.

import { inspect } from './detect';
import { applyPlan } from './rewrite';
import type { Analysis, RestampResult } from './types';

export type * from './types';

/** Reports whether the file's timestamps are stretched. Never throws. */
export function analyze(data: Uint8Array): Analysis {
	return inspect(data).analysis;
}

/** Analyzes the file and, if it's broken, returns a fixed copy. Never throws or modifies `data`. */
export function restamp(data: Uint8Array): RestampResult {
	const { analysis, plan } = inspect(data);
	if (!plan) return { analysis, output: null };
	try {
		return { analysis, output: applyPlan(data, plan) };
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return { analysis: { status: 'unsupported', reason: `The file couldn't be rewritten: ${reason}` }, output: null };
	}
}
