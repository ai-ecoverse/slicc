import Foundation

public struct SamplingSession {

    public let id: String

    public let weight: Int

    public let isSelected: Bool

    public init(
        id: String,
        config: SamplingConfig,
        random: RandomSource = SystemRandomSource()
    ) {
        self.id = id
        self.weight = config.weight
        self.isSelected = SamplingSession.computeIsSelected(
            weight: config.weight,
            random: random
        )
    }

    public static func computeIsSelected(weight: Int, random: RandomSource) -> Bool {
        guard weight > 0 else { return false }
        return random.nextUnitDouble() * Double(weight) < 1.0
    }
}
