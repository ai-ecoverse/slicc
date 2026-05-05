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
        .package(url: "https://github.com/stasel/WebRTC.git", .upToNextMajor(from: "147.0.0"))
    ],
    targets: [
        .target(
            name: "SliccFollower",
            dependencies: [
                .product(name: "WebRTC", package: "WebRTC")
            ],
            path: "SliccFollower",
            resources: [
                .copy("WebView/chat.html"),
                .copy("WebView/chat.css"),
                .copy("WebView/chat.js"),
                .process("Resources/Assets.xcassets")
            ]
        )
    ]
)

