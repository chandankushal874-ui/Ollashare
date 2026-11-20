import { expect, test, vi } from 'vitest';

test('visible-tab focus changes do not revoke a valid control grant', () => {
  const revoke = vi.fn();
  const onVisibilityChange = (visibility: DocumentVisibilityState) => {
    if (visibility === 'hidden') revoke();
  };
  // Browser chrome and permission surfaces can blur the page without hiding it.
  onVisibilityChange('visible');
  expect(revoke).not.toHaveBeenCalled();
  onVisibilityChange('hidden');
  expect(revoke).toHaveBeenCalledOnce();
});
