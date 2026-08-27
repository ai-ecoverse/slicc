// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "Sliccstart",
    platforms: [.macOS(.v14)],
    dependencies: [
        .package(url: "https://github.com/s1ntoneli/AppUpdater.git", exact: "0.2.0"),
        .package(path: "../swift-optel"),
        .package(path: "../swift-traysession"),
        .package(path: "../swift-traykit"),
        .package(path: "../swift-trayfollower"),
        .package(path: "../swift-widgetkit"),
    ],
    targets: [
        // Keep slicc-server as a separate Swift package; build-app.sh bundles its binary.
        .executableTarget(
            name: "Sliccstart",
            dependencies: [
                "AppUpdater",
                .product(name: "SwiftOptel", package: "swift-optel"),
                .product(name: "SliccTraySession", package: "swift-traysession"),
                .product(name: "SliccTrayVFS", package: "swift-traykit"),
                .product(name: "SliccTrayFollower", package: "swift-trayfollower"),
                .product(name: "SliccWidgetKit", package: "swift-widgetkit"),
            ],
            path: "Sliccstart",
            resources: [.process("Resources")]
        ),
        .testTarget(
            name: "SliccstartTests",
            // The suite imports these three directly (AppUpdater release
            // decoding, SwiftOptel error reports, the tray-session CLI), so
            // they are declared here instead of being reached transitively
            // through Sliccstart.
            dependencies: [
                "Sliccstart",
                "AppUpdater",
                .product(name: "SwiftOptel", package: "swift-optel"),
                .product(name: "SliccTraySession", package: "swift-traysession"),
                .product(name: "SliccTrayVFS", package: "swift-traykit"),
                .product(name: "SliccTrayFollower", package: "swift-trayfollower"),
                .product(name: "SliccWidgetKit", package: "swift-widgetkit"),
            ],
            path: "SliccstartTests"
        ),
    ]
)
