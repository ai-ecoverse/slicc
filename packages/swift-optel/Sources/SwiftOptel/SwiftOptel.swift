import Foundation

/// Placeholder entry point for the SwiftOptel library.
///
/// OpTel = Operational Telemetry — Adobe's RUM-style operational telemetry;
/// not to be confused with OpenTelemetry (OTel).
///
/// The real RUM / Operational Telemetry surface is implemented in later tasks;
/// this type only exists so the package has something to build and test against.
public enum SwiftOptel {
    /// Package version string. Bumped manually when the surface stabilizes.
    public static let version = "0.0.0"
}
