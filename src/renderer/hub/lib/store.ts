import { writable } from 'svelte/store';
import type { HubState } from '../../../shared/hubTypes';

export const hubState = writable<HubState | null>(null);

export async function initStore(): Promise<void> {
  hubState.set(await window.loftHub.getState());
  window.loftHub.onStateChanged((s) => hubState.set(s));
}
