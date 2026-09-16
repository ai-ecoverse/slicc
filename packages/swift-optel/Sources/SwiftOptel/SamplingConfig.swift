import Foundation

public struct SamplingConfig: Equatable {

    public let weight: Int

    public static let defaultWeight: Int = 100

    public static let `default` = SamplingConfig(weight: defaultWeight)

    public init(weight: Int) {
        self.weight = weight
    }

    public init(rate: String?) {
        self.weight = SamplingConfig.parseWeight(from: rate)
    }

    public static func parseWeight(from rate: String?) -> Int {
        guard let rate else { return defaultWeight }
        switch rate {
        case "on": return 1
        case "off": return 0
        case "high": return 10
        case "low": return 1000
        default: return defaultWeight
        }
    }
}
