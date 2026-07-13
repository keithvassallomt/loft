// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import ServiceRow from '../src/renderer/hub/components/ServiceRow.svelte';
import type { HubService } from '../src/shared/hubTypes';

const svc: HubService = {
  id: 'whatsapp', displayName: 'WhatsApp', selfHosted: false, installed: true,
  running: true, visible: true, badge: 3, badgesEnabled: true, dnd: false,
  openOnStartup: false, customUrl: '',
};

beforeEach(() => {
  (globalThis as unknown as { window: { loftHub: unknown } }).window.loftHub = { openService: vi.fn() };
});

describe('ServiceRow', () => {
  it('shows name, running status and badge', () => {
    render(ServiceRow, { props: { svc, onGear: vi.fn() } });
    expect(screen.getByText('WhatsApp')).toBeTruthy();
    expect(screen.getByText('Running')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
  });

  it('hides the badge when badgesEnabled is false', () => {
    render(ServiceRow, { props: { svc: { ...svc, badgesEnabled: false }, onGear: vi.fn() } });
    expect(screen.queryByText('3')).toBeNull();
  });
});
