import { describe } from 'vitest';

/**
 * Switches between `describe` and `describe.skip` based on the
 * `SLICC_TEST_LIVE=1` env var so the suite is invocable without env
 * configuration but no-ops cleanly when not opted in. `npm run test:live`
 * sets the env var; bare `npm test` does not.
 */
export const liveDescribe = process.env['SLICC_TEST_LIVE'] === '1' ? describe : describe.skip;
