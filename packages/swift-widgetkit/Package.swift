// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "SliccWidgetKit",
    // Both widget hosts: the iOS follower's `SliccWidgets` extension and
    // Sliccstart's `SliccstartWidgets` extension. Everything here is
    // Foundation + SwiftUI + WidgetKit — no WebRTC, no AppKit/UIKit — so a
    // widget process stays cheap enough for WidgetKit's memory budget.
    platforms: [.macOS(.v14), .iOS("18.0")],
    products: [
        .library(name: "SliccWidgetKit", targets: ["SliccWidgetKit"])
    ],
    targets: [
        .target(
            name: "SliccWidgetKit",
            path: "Sources/SliccWidgetKit"
        ),
        // Design tool: renders the widget layouts to PNG contact sheets so the
        // states nobody remembers to check get drawn on every review.
        .executableTarget(
            name: "slicc-widget-gallery",
            dependencies: ["SliccWidgetKit"],
            path: "Sources/slicc-widget-gallery"
        ),
        .testTarget(
            name: "SliccWidgetKitTests",
            dependencies: ["SliccWidgetKit"],
            path: "Tests/SliccWidgetKitTests"
        ),
    ]
)
