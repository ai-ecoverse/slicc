// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "SliccFollower",
    platforms: [
        .iOS(.v26)
    ],
    products: [
        .library(
            name: "SliccTrayKit",
            targets: ["SliccTrayKit"]
        ),
        .library(
            name: "SliccFollower",
            targets: ["SliccFollower"]
        ),
    ],
    dependencies: [
        .package(url: "https://github.com/Lakr233/libghostty-spm", exact: "1.5.1"),
        .package(
            url: "https://github.com/huggingface/swift-huggingface",
            .upToNextMinor(from: "0.9.0")),
        .package(url: "https://github.com/stasel/WebRTC.git", .upToNextMajor(from: "152.0.0")),
        .package(path: "../swift-traysession"),
        .package(path: "../swift-trayfollower"),
        .package(path: "../swift-traykit"),
    ],
    targets: [
        .target(
            name: "SliccTrayKit",
            dependencies: [
                // The tray-follower transport core (formerly SliccTrayKit's own
                // Models/ + Networking/), now shared with swift-server. Re-exported
                // module-wide via SliccTrayKit/TrayFollowerExports.swift.
                .product(name: "SliccTrayFollower", package: "swift-trayfollower"),
                // Shared leader VFS / File Provider logic (FsClient, credentials,
                // LeaderVFSProvider). Re-exported via TrayVFSExports.swift.
                .product(name: "SliccTrayVFS", package: "swift-traykit"),
            ],
            path: "SliccTrayKit"
        ),
        .target(
            name: "SliccFollower",
            dependencies: [
                .product(name: "GhosttyTerminal", package: "libghostty-spm"),
                "SliccTrayKit",
                .product(name: "HuggingFace", package: "swift-huggingface"),
                .product(name: "WebRTC", package: "WebRTC"),
                .product(name: "SliccTraySession", package: "swift-traysession"),
                .product(name: "SliccTrayFollower", package: "swift-trayfollower"),
            ],
            path: "SliccFollower",
            exclude: ["SliccFollower.entitlements", "Tests"],
            resources: [
                .process("Resources/Assets.xcassets"),
                .copy("Resources/PrivacyInfo.xcprivacy"),
                .copy("Resources/KokoroLicenses/FluidAudio-LICENSE.txt"),
                .copy("Resources/KokoroLicenses/FluidAudio-VENDORED.md"),
                .copy("Resources/KokoroLicenses/Misaki-LICENSE.txt"),
                .copy("Resources/KokoroLicenses/OnDeviceTTS-LICENSE.txt"),
                .copy("Resources/KokoroLicenses/OnDeviceTTS-NOTICE.txt"),
                .copy("Resources/us_gold.json"),
                .copy("Resources/us_silver.json"),
            ]
        ),
    ],
    swiftLanguageModes: [.v5]
)
