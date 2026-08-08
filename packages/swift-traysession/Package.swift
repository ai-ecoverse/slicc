// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "SliccTraySession",
    // Both consumers: macOS for swift-launcher (Sliccstart), iOS for ios-app
    // (SliccFollower). Nothing here may import AppKit/UIKit. The WebRTC-bearing
    // tray-follower transport lives in the sibling `packages/swift-trayfollower`
    // package so this one stays Foundation-only.
    platforms: [.macOS(.v14), .iOS("18.0")],
    products: [
        .library(
            name: "SliccTraySession",
            targets: ["SliccTraySession"]
        )
    ],
    targets: [
        .target(
            name: "SliccTraySession",
            path: "Sources/SliccTraySession"
        ),
        .testTarget(
            name: "SliccTraySessionTests",
            dependencies: ["SliccTraySession"],
            path: "Tests/SliccTraySessionTests"
        ),
    ]
)
