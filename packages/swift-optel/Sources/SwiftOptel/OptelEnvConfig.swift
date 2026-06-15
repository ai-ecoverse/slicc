import Foundation

/// Pure resolvers for environment-variable overrides honored by ``Optel``.
///
/// Two override knobs are recognized:
///
/// - `OPTEL_RATE` — overrides the sampling rate passed to ``Optel/configure``.
///   When present and non-empty, this value wins over the explicit `rate:`
///   argument. Accepts the same values as ``SamplingConfig/init(rate:)`` (the
///   `on`/`off`/`high`/`low` aliases; anything else falls back to the default
///   weight of `100`). This is the native analogue of the `?rum=on` URL knob
///   in `helix-rum-js` — set `OPTEL_RATE=on` to force 100% sampling at
///   runtime without rebuilding.
///
/// - `OPTEL_DEBUG` — when set to a truthy value (`1`/`true`/`on`/`yes`,
///   case-insensitive), enables wire-level `os.Logger` logging in the default
///   ``URLSessionOptelTransport`` (request URL, payload size, HTTP status).
///   Default off → no logging, no behavior change.
///
/// The resolvers are intentionally pure: they take an injected
/// `[String: String]` environment dictionary so they can be unit-tested
/// without mutating `ProcessInfo`. The non-pure call site in
/// ``Optel/configure(appID:rate:collectBaseURL:transport:randomSource:)``
/// simply passes `ProcessInfo.processInfo.environment`.
public enum OptelEnvConfig {
    /// Environment variable name for the sampling-rate override.
    public static let rateKey = "OPTEL_RATE"

    /// Environment variable name for the debug-logging flag.
    public static let debugKey = "OPTEL_DEBUG"

    /// Resolve the effective sampling rate string. The env override takes
    /// precedence when present and non-empty; otherwise the explicit value is
    /// returned unchanged (which may itself be `nil`, yielding the default
    /// weight downstream in ``SamplingConfig/init(rate:)``).
    public static func resolveRate(
        explicit: String?,
        environment: [String: String]
    ) -> String? {
        if let envRate = environment[rateKey], !envRate.isEmpty {
            return envRate
        }
        return explicit
    }

    /// Resolve the debug-logging flag from the environment. Truthy values are
    /// `1`/`true`/`on`/`yes` (case-insensitive); any other value (including
    /// `0`/`false`/`off`/`no`, empty, or missing key) returns `false`.
    public static func resolveDebugLogging(environment: [String: String]) -> Bool {
        guard let value = environment[debugKey] else { return false }
        switch value.lowercased() {
        case "1", "true", "on", "yes": return true
        default: return false
        }
    }
}
