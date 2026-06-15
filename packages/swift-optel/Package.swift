// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "SwiftOptel",
    platforms: [.iOS(.v16), .macOS(.v13)],
    products: [
        .library(
            name: "SwiftOptel",
            targets: ["SwiftOptel"]
        ),
    ],
    targets: [
        .target(
            name: "SwiftOptel",
            path: "Sources/SwiftOptel"
        ),
        .testTarget(
            name: "SwiftOptelTests",
            dependencies: ["SwiftOptel"],
            path: "Tests/SwiftOptelTests"
        ),
    ]
)
