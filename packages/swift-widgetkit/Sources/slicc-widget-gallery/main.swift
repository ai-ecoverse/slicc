import AppKit
import SliccWidgetKit
import SwiftUI

/// Renders the widget design to PNG contact sheets, so a layout can be
/// reviewed without installing anything on a home screen.
///
///     swift run slicc-widget-gallery ./out
///
/// One PNG per family x fixture x colour scheme at 4x, plus one sheet per
/// family x scheme laying every fixture out side by side. Sheets are split by
/// family on purpose: a single all-in-one sheet is tall enough that any viewer
/// scales it down, and a widget reviewed at half size is not reviewed.
///
/// This is a design tool, not a golden-image gate: it asserts nothing. Its
/// value is that the states nobody remembers to check — disconnected, crowded,
/// no-cone — get drawn every time.
struct GalleryItem {
    let family: String
    let size: CGSize
    /// Columns in that family's sheet, chosen so no sheet is taller than wide.
    let columns: Int
    let view: (WidgetRenderContext) -> AnyView
}

/// iPhone widget point sizes (iPhone 16 Pro class). macOS runs ~3pt narrower
/// per family; nothing in the layout is within 3pt of breaking.
let items: [GalleryItem] = [
    GalleryItem(family: "small", size: CGSize(width: 158, height: 158), columns: 3) {
        AnyView(UnitsWidgetSmall(context: $0))
    },
    GalleryItem(family: "medium", size: CGSize(width: 338, height: 158), columns: 2) {
        AnyView(UnitsWidgetMedium(context: $0))
    },
    GalleryItem(family: "large", size: CGSize(width: 338, height: 354), columns: 3) {
        AnyView(UnitsWidgetLarge(context: $0))
    },
]

/// Tiles are rendered at 4x — a 158pt small widget lands at 632px, which
/// survives being embedded in a review thread.
let tileScale: CGFloat = 4
let sheetScale: CGFloat = 3

let outDir = URL(fileURLWithPath: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "./widget-gallery")
try? FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)

@MainActor
func writePNG(_ view: some View, scale: CGFloat, to url: URL) {
    let renderer = ImageRenderer(content: view)
    renderer.scale = scale
    guard let image = renderer.nsImage,
        let tiff = image.tiffRepresentation,
        let bitmap = NSBitmapImageRep(data: tiff),
        let png = bitmap.representation(using: .png, properties: [:])
    else {
        FileHandle.standardError.write(Data("failed to render \(url.lastPathComponent)\n".utf8))
        return
    }
    try? png.write(to: url)
}

/// One widget as the system frames it: the tile's content margins, the canvas,
/// and the home screen's corner radius.
@MainActor
func tile(_ item: GalleryItem, _ context: WidgetRenderContext, _ scheme: ColorScheme) -> some View {
    let palette = WidgetPalette.resolve(scheme)
    return item.view(context)
        .environment(\.colorScheme, scheme)
        .padding(15)
        .frame(width: item.size.width, height: item.size.height)
        .background(palette.canvas)
        .clipShape(RoundedRectangle(cornerRadius: 22))
}

@MainActor
func run() {
    for scheme in [ColorScheme.light, .dark] {
        let schemeName = scheme == .light ? "light" : "dark"
        let palette = WidgetPalette.resolve(scheme)

        for item in items {
            var labelled: [AnyView] = []
            for (name, snapshot) in WidgetSnapshot.allFixtures {
                let context = WidgetRenderContext(
                    snapshot: snapshot,
                    now: WidgetSnapshot.fixtureCaptureDate.addingTimeInterval(240),
                    host: .follower)
                let drawn = tile(item, context, scheme)
                writePNG(
                    drawn, scale: tileScale,
                    to: outDir.appendingPathComponent("\(item.family)-\(name)-\(schemeName).png"))
                labelled.append(
                    AnyView(
                        VStack(alignment: .leading, spacing: 6) {
                            Text(name)
                                .font(.system(size: 11, weight: .semibold, design: .monospaced))
                                .foregroundStyle(palette.inkSecondary)
                            drawn
                        }))
            }

            let rows = stride(from: 0, to: labelled.count, by: item.columns).map {
                Array(labelled[$0..<min($0 + item.columns, labelled.count)])
            }
            let sheet = VStack(alignment: .leading, spacing: 22) {
                Text("Cones & Scoops · \(item.family) · \(schemeName)")
                    .font(.system(size: 16, weight: .bold))
                    .foregroundStyle(palette.ink)
                ForEach(Array(rows.enumerated()), id: \.offset) { row in
                    HStack(alignment: .top, spacing: 22) {
                        ForEach(Array(row.element.enumerated()), id: \.offset) { $0.element }
                    }
                }
            }
            .padding(26)
            .background(scheme == .light ? Color(white: 0.90) : Color(white: 0.06))
            .environment(\.colorScheme, scheme)

            writePNG(
                sheet, scale: sheetScale,
                to: outDir.appendingPathComponent("sheet-\(item.family)-\(schemeName).png"))
        }
    }
    print("wrote gallery to \(outDir.path)")
}

MainActor.assumeIsolated { run() }
