# swift-pin-reconcile

Keeps GitHub SPM packages that appear in **both** a xcodegen `project.yml`
(`exactVersion` / `minorVersion`) and a `Package.swift` on overlapping versions.

Renovate's swift manager updates `Package.swift` / `Package.resolved`. A regex
`customManagers` entry updates `project.yml`. Those used to open two PRs for
the same bump (PRs #2320 / #2348): one side on 151, the other on 150, and SPM
failed with `depends on 'webrtc' 151 and root depends on 'webrtc' 150`.

- **`lib.mjs`** — pure parse / compare / apply (unit-tested in `lib.test.mjs`).
- **`check-swift-pins.mjs`** — the guard. `npm run lint:swift-pins`, wired into
  `lint` / `lint:ci`. Also asserts `renovate.json` labels every dual pin
  `swift-pin` so the workflow below actually runs.
- **`reconcile.mjs`** — `--write` raises the stale side to the higher version
  already in the tree and, for exact pins, peels the git tag into
  `Package.resolved`. Consumed by
  [`.github/workflows/renovate-swift-pin-reconcile.yml`](../../../.github/workflows/renovate-swift-pin-reconcile.yml).

The reconcile never invents a version and never lowers a pin. Range-style pins
(`minorVersion` / `upToNextMinor`) are left to resolve anywhere inside the
range; only `exactVersion` / `exact` pins force `Package.resolved` onto the
exact tag. Package.swift `from: "1.0.0"` is SwiftPM's `1.0.0..<2.0.0`
shorthand (same upper bound as `.upToNextMajor(from:)`), not an open `>=`.
