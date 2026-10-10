// Usage: swift scripts/render-icon.swift
// Renders the SVGs under assets/ into PNGs with a transparent background (macOS
// only, no new dependency: AppKit already ships with the OS):
//   assets/icon.svg         -> assets/icon.png (1024x1024, the Dock icon)
//   assets/trayTemplate.svg -> assets/trayTemplate.png (16x16) and
//                              assets/trayTemplate@2x.png (32x32), the menu bar
//                              template image (#191)
//   assets/dot-<status>.svg -> assets/dot-<status>.png (16x16) and
//                              assets/dot-<status>@2x.png (32x32), the menu bar
//                              menu's worker dots (#192), for working, waiting,
//                              review, approval (#268) and backoff (#805); drawn in sRGB so they
//                              keep the board's exact colors
//   assets/tray-<ink>-<signal>.svg -> assets/tray-<ink>-<signal>.png (16x16) and
//                              assets/tray-<ink>-<signal>@2x.png (32x32), the menu
//                              bar icon with the effective signal's badge (#196):
//                              a black (dark) or white (light) comb, green, yellow
//                              or red; drawn in sRGB like the dots
// Paths are resolved relative to the current working directory, so run this
// from the repo root.
import AppKit

func render(_ svg: String, to png: String, size: Int, colorSpace: NSColorSpace? = nil) throws {
    guard let image = NSImage(contentsOfFile: svg) else {
        fatalError("could not load \(svg)")
    }
    guard let blank = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
    ) else {
        fatalError("could not create bitmap rep for \(png)")
    }
    // a colored image is drawn into a bitmap of the SVG's own color space (sRGB), so its fills land unconverted
    guard let rep = colorSpace.map({ blank.retagging(with: $0) }) ?? blank else {
        fatalError("could not retag \(png)")
    }

    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    // no fill: the bitmap starts fully transparent, unlike a white-backed rasterizer
    image.draw(in: NSRect(x: 0, y: 0, width: size, height: size))
    NSGraphicsContext.restoreGraphicsState()

    guard let data = rep.representation(using: .png, properties: [:]) else {
        fatalError("could not encode \(png)")
    }
    try data.write(to: URL(fileURLWithPath: png))
}

try render("assets/icon.svg", to: "assets/icon.png", size: 1024)
try render("assets/trayTemplate.svg", to: "assets/trayTemplate.png", size: 16)
try render("assets/trayTemplate.svg", to: "assets/trayTemplate@2x.png", size: 32)

for status in ["working", "waiting", "review", "approval", "backoff"] {
    try render("assets/dot-\(status).svg", to: "assets/dot-\(status).png", size: 16, colorSpace: .sRGB)
    try render("assets/dot-\(status).svg", to: "assets/dot-\(status)@2x.png", size: 32, colorSpace: .sRGB)
}

for ink in ["dark", "light"] {
    for signal in ["green", "yellow", "red"] {
        let name = "assets/tray-\(ink)-\(signal)"
        try render("\(name).svg", to: "\(name).png", size: 16, colorSpace: .sRGB)
        try render("\(name).svg", to: "\(name)@2x.png", size: 32, colorSpace: .sRGB)
    }
}
