import { describe, it, expect } from 'vitest';
import { isAllowedPermission } from '../src/main/session';

describe('isAllowedPermission', () => {
  it('allows media and notifications (call-critical)', () => {
    expect(isAllowedPermission('media')).toBe(true);
    expect(isAllowedPermission('notifications')).toBe(true);
    expect(isAllowedPermission('display-capture')).toBe(true);
  });
  it('denies unrelated permissions', () => {
    expect(isAllowedPermission('geolocation')).toBe(false);
    expect(isAllowedPermission('midi')).toBe(false);
  });
});
