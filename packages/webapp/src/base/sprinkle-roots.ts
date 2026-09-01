/**
 * The VFS roots sprinkles are discovered and watched under.
 *
 * One list, three consumers that must agree: `ui/sprinkle-discovery.ts`
 * (which mines them for `.shtml` files), `ui/sprinkle-manager.ts` (whose
 * legacy/test watcher registers under them), and the production watcher
 * in `kernel/kernel-worker.ts` (which auto-reloads open sprinkles). It
 * lives in `base/` because `kernel/` may not import `ui/` — see the
 * layer-back-edge gate.
 *
 * Deliberately NOT `/`: discovery used to walk the whole VFS at boot,
 * which under a `--mount`ed host folder meant one `/api/hostfs/list`
 * request per directory all the way into `node_modules` (issue #2717).
 * `/mnt`, `/proc` and `/tmp` are not roots; a mount is crawled only when
 * it sits inside one of these.
 */
export const SPRINKLE_ROOTS = ['/workspace', '/shared', '/scoops', '/home'] as const;
