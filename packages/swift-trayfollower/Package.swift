// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "SliccTrayFollower",
    // Consumers: iOS (ios-app / SliccFollower) and macOS (swift-server, for
    // egress-blocked Electron apps). One shared copy on one stasel/WebRTC so the
    // framework and the transport source are not double-shipped.
    platforms: [.macOS(.v14), .iOS("18.0")],
    products: [
        .library(name: "SliccTrayFollower", targets: ["SliccTrayFollower"])
    ],
    dependencies: [
        .package(url: "https://github.com/stasel/WebRTC.git", .upToNextMajor(from: "152.0.0"))
    ],
    targets: [
        .target(
            name: "SliccTrayFollower",
            dependencies: [
                .product(name: "WebRTC", package: "WebRTC")
            ],
            path: "Sources/SliccTrayFollower"
        ),
        .testTarget(
            name: "SliccTrayFollowerTests",
            dependencies: ["SliccTrayFollower"],
            path: "Tests/SliccTrayFollowerTests"
        ),
    ]
)
