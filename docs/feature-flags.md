# Feature flags

Flags live in three places:

1. The typed registry in `packages/webapp/src/core/feature-flags.ts` (`FeatureFlagId` + `FEATURE_FLAGS`). Unknown ids arriving from the worker or a Cherry host are dropped rather than trusted.
2. The worker's `FEATURE_FLAGS` var in `packages/cloudflare-worker/wrangler.jsonc` (production and staging). Per-float maps overlay `base`. `packages/cloudflare-worker/src/flags.ts` serves `GET /api/flags`.
3. A Cherry host may push `userToggleable` flags at mount (`mountSlicc({ flags })`). That is session-only and cannot flip a flag the registry did not mark safe for the `cherry` float.

Read a flag with `isFeatureEnabled('…')` or `getFeatureValue('…')`. The Experimental features dialog is generated from `listFlags()`; a new user-toggleable flag needs no extra UI wiring.

`npm run lint:dead-flags` (`packages/dev-tools/tools/check-dead-flags.mjs`) fails when a registry id has no consumer, and when a consumer names an id the registry does not declare. Worker overlay keys and `FALLBACK_BASE_FLAGS` must also name a registered id — that is the string-boundary drift the `FeatureFlagId` union cannot see. A wrangler entry is not a consumer: a flag that exists only in the registry and wrangler, with no `isFeatureEnabled` / `getFeatureValue` / Cherry host read, is dead.

A flag parked on purpose gets `// unused-flag-ok: <reason>` (or `// unused-dep-ok:`) on its registry entry.

## Lifecycle

**Propose.** Add the id to `FeatureFlagId` and `FEATURE_FLAGS`, with `since` set to today (`YYYY-MM-DD`). Default off unless the feature is already the product. Mirror the id in both wrangler `FEATURE_FLAGS` lists only when the worker should override the bundle. Ship a consumer in the same PR.

**Graduate.** When the feature is the product on every float: set `defaultValue` (and wrangler `base`, if present) to the shipping value, set `userToggleable: false` so it leaves Settings → Experimental, and reset `since` to the graduation date. Keep a worker key only if operators still need a kill switch that is not a release — `compact-on-idle` is the example. A `floatDefaults` carve-out (Cherry, usually) means it is not yet 100% and `since` should not be reset for the 90-day clock.

**Retire.** The owner is whoever last set that flag's default — the author of the graduation, or of the original PR if it never graduated. The trigger is either the dead-flag lint, or ninety days at a constant default on every float, which the same gate reports as `stale-flag`. Delete the id, the losing branch, wrangler keys, Cherry examples, and tests that existed only to toggle it. Do not leave an always-true `isFeatureEnabled` call behind.

`experimental-settings` is a control flag for the dialog itself, not a feature in flight; it stays.
