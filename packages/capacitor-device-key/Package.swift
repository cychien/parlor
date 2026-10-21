// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "ParlorCapacitorDeviceKey",
    platforms: [.iOS(.v15), .macOS(.v13)],
    products: [
        .library(
            name: "ParlorCapacitorDeviceKey",
            targets: ["ParlorDeviceKeyPlugin"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0")
    ],
    targets: [
        .target(
            name: "ParlorDeviceKeyCore",
            path: "ios/Sources/ParlorDeviceKeyCore"),
        .target(
            name: "ParlorDeviceKeyPlugin",
            dependencies: [
                "ParlorDeviceKeyCore",
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm")
            ],
            path: "ios/Sources/ParlorDeviceKeyPlugin"),
        .testTarget(
            name: "ParlorDeviceKeyCoreTests",
            dependencies: ["ParlorDeviceKeyCore"],
            path: "ios/Tests/ParlorDeviceKeyCoreTests")
    ]
)
