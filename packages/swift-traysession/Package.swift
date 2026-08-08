// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "SliccTraySession",
    // Both consumers: macOS for swift-launcher (Sliccstart) + swift-server, iOS
    // for ios-app (SliccFollower). Nothing in `SliccTraySession` may import
    // AppKit/UIKit. The WebRTC-bearing `SliccTrayFollower` is a SEPARATE product
    // so Foundation-only consumers (swift-launcher) never pull in WebRTC.
    platforms: [.macOS(.v14), .iOS("18.0")],
    products: [
        .library(
            name: "SliccTraySession",
            targets: ["SliccTraySession"]
        ),
        .library(
            name: "SliccTrayFollower",
            targets: ["SliccTrayFollower"]
        ),
    ],
    dependencies: [
        .package(url: "https://github.com/stasel/WebRTC.git", .upToNextMajor(from: "150.0.0"))
    ],
    targets: [
        .target(
            name: "SliccTraySession",
            path: "Sources/SliccTraySession"
        ),
        // Headless tray-follower transport (signalling + WebRTC + data channel +
        // tray-sync protocol), shared by the iOS app and swift-server so the
        // WebRTC framework is not double-shipped. CDP-agnostic: consumers layer
        // their own servicing on `TrayFollowerConnector`'s send/receive surface.
        .target(
            name: "SliccTrayFollower",
            dependencies: [
                .product(name: "WebRTC", package: "WebRTC")
            ],
            path: "Sources/SliccTrayFollower"
        ),
        .testTarget(
            name: "SliccTraySessionTests",
            dependencies: ["SliccTraySession"],
            path: "Tests/SliccTraySessionTests"
        ),
    ]
)
