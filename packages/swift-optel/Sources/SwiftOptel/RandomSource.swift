import Foundation





public protocol RandomSource {
    
    func nextUnitDouble() -> Double
}


public struct SystemRandomSource: RandomSource {
    public init() {}

    public func nextUnitDouble() -> Double {
        Double.random(in: 0..<1)
    }
}
