import type { Analysis } from '$lib/restamp/types';

export type ItemState = 'queued' | 'processing' | 'done' | 'error';

/** One file in the list. `url` is an object URL for the fixed file (owner must revoke it). */
export interface Item {
	id: number;
	name: string;
	size: number;
	state: ItemState;
	analysis?: Analysis;
	url?: string;
	error?: string;
}
