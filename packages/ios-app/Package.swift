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
        .package(url: "https://github.com/Lakr233/libghostty-spm", exact: "1.3.2"),
        .package(url: "https://github.com/stasel/WebRTC.git", .upToNextMajor(from: "150.0.0")),
        .package(path: "../swift-traysession"),
    ],
    targets: [
        .target(
            name: "SliccFollower",
            dependencies: [
                .product(name: "GhosttyTerminal", package: "libghostty-spm"),
                .product(name: "WebRTC", package: "WebRTC"),
                .product(name: "SliccTraySession", package: "swift-traysession"),
            ],
            path: "SliccFollower",
            resources: [
                .process("Resources/Assets.xcassets")
            ]
        )
    ]
)
