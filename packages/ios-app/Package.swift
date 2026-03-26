// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "SliccFollower",
    platforms: [
        .iOS(.v17)
    ],
    products: [
        .library(
            name: "SliccFollower",
            targets: ["SliccFollower"]
        )
    ],
    dependencies: [
        .package(url: "https://github.com/stasel/WebRTC.git", .upToNextMajor(from: "125.0.0"))
    ],
    targets: [
        .target(
            name: "SliccFollower",
            dependencies: [
                .product(name: "WebRTC", package: "WebRTC")
            ],
            path: "SliccFollower"
        )
    ]
)

