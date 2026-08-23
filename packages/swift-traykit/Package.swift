// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "SliccTrayVFS",
    // Shared by the iOS follower (Files.app) and macOS Sliccstart (Finder).
    // Imports FileProvider + WebRTC (via SliccTrayFollower) for the leader VFS
    // mount; nothing here may import AppKit/UIKit.
    platforms: [.macOS(.v14), .iOS("18.0")],
    products: [
        .library(name: "SliccTrayVFS", targets: ["SliccTrayVFS"])
    ],
    dependencies: [
        .package(url: "https://github.com/stasel/WebRTC.git", .upToNextMajor(from: "151.0.0")),
        .package(path: "../swift-trayfollower"),
    ],
    targets: [
        .target(
            name: "SliccTrayVFS",
            dependencies: [
                .product(name: "WebRTC", package: "WebRTC"),
                .product(name: "SliccTrayFollower", package: "swift-trayfollower"),
            ],
            path: "Sources/SliccTrayVFS"
        ),
        .testTarget(
            name: "SliccTrayVFSTests",
            dependencies: [
                "SliccTrayVFS",
                .product(name: "SliccTrayFollower", package: "swift-trayfollower"),
            ],
            path: "Tests/SliccTrayVFSTests"
        ),
    ]
)
