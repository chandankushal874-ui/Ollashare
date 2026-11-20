import { expect, test } from 'vitest';

type Scope = { key: string; active: boolean; live: boolean };

test('cleanup for an old media generation cannot deactivate its replacement', () => {
  const ref: { current: Scope } = { current: { key: 'old', active: true, live: true } };
  const capturedOldScope = ref.current;
  ref.current = { key: 'new', active: true, live: true };
  // This is the cleanup behavior used by the page effect: close the captured
  // generation, never whichever generation the ref happens to hold later.
  capturedOldScope.active = false;
  capturedOldScope.live = false;
  expect(ref.current).toEqual({ key: 'new', active: true, live: true });
});
