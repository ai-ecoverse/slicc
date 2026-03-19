// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "SliccstartCore",
  platforms: [.macOS(.v13)],
  products: [
    .library(name: "SliccstartCore", targets: ["SliccstartCore"]),
    .library(name: "SliccstartDesktop", targets: ["SliccstartDesktop"]),
    .executable(name: "SliccstartApp", targets: ["SliccstartApp"]),
    .executable(name: "SliccstartAppBundler", targets: ["SliccstartAppBundler"]),
  ],
  targets: [
    .target(name: "SliccstartCore"),
    .target(name: "SliccstartDesktop", dependencies: ["SliccstartCore"]),
    .executableTarget(name: "SliccstartApp", dependencies: ["SliccstartDesktop"]),
    .executableTarget(name: "SliccstartAppBundler", dependencies: ["SliccstartCore"]),
    .testTarget(name: "SliccstartCoreTests", dependencies: ["SliccstartCore"]),
    .testTarget(name: "SliccstartDesktopTests", dependencies: ["SliccstartDesktop", "SliccstartCore"]),
  ]
)