import Foundation
import CoreGraphics
import ImageIO

let canvasSize = 1024
let size = CGFloat(canvasSize)

let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!

func color(_ red: CGFloat, _ green: CGFloat, _ blue: CGFloat, _ alpha: CGFloat = 1.0) -> CGColor {
    CGColor(colorSpace: colorSpace, components: [red / 255.0, green / 255.0, blue / 255.0, alpha])!
}

func radians(_ degrees: CGFloat) -> CGFloat {
    degrees * .pi / 180.0
}

func arcPath(center: CGPoint, radius: CGFloat, startDegrees: CGFloat, endDegrees: CGFloat, segments: Int) -> CGPath {
    let path = CGMutablePath()
    let start = radians(startDegrees)
    let end = radians(endDegrees)

    for index in 0...segments {
        let progress = CGFloat(index) / CGFloat(segments)
        let angle = start + (end - start) * progress
        let point = CGPoint(
            x: center.x + cos(angle) * radius,
            y: center.y + sin(angle) * radius
        )

        if index == 0 {
            path.move(to: point)
        } else {
            path.addLine(to: point)
        }
    }

    return path
}

func strokeGradient(
    _ context: CGContext,
    path: CGPath,
    lineWidth: CGFloat,
    colors: [CGColor],
    locations: [CGFloat],
    start: CGPoint,
    end: CGPoint
) {
    context.saveGState()
    context.addPath(path)
    context.setLineWidth(lineWidth)
    context.setLineCap(.round)
    context.setLineJoin(.round)
    context.replacePathWithStrokedPath()
    context.clip()

    let gradient = CGGradient(colorsSpace: colorSpace, colors: colors as CFArray, locations: locations)!
    context.drawLinearGradient(gradient, start: start, end: end, options: [])

    context.restoreGState()
}

func fillGradient(
    _ context: CGContext,
    path: CGPath,
    colors: [CGColor],
    locations: [CGFloat],
    start: CGPoint,
    end: CGPoint
) {
    context.saveGState()
    context.addPath(path)
    context.clip()

    let gradient = CGGradient(colorsSpace: colorSpace, colors: colors as CFArray, locations: locations)!
    context.drawLinearGradient(gradient, start: start, end: end, options: [])

    context.restoreGState()
}

let bitmapInfo = CGBitmapInfo.byteOrder32Big.rawValue | CGImageAlphaInfo.noneSkipLast.rawValue
guard let context = CGContext(
    data: nil,
    width: canvasSize,
    height: canvasSize,
    bitsPerComponent: 8,
    bytesPerRow: 0,
    space: colorSpace,
    bitmapInfo: bitmapInfo
) else {
    fatalError("Could not create drawing context")
}

context.interpolationQuality = .high
context.setAllowsAntialiasing(true)
context.setShouldAntialias(true)

let background = CGGradient(
    colorsSpace: colorSpace,
    colors: [
        color(13, 15, 50),
        color(24, 43, 88),
        color(5, 64, 70)
    ] as CFArray,
    locations: [0.0, 0.48, 1.0]
)!
context.setFillColor(color(13, 15, 50))
context.fill(CGRect(x: 0, y: 0, width: size, height: size))
context.drawLinearGradient(
    background,
    start: CGPoint(x: 78, y: 40),
    end: CGPoint(x: 935, y: 980),
    options: [.drawsBeforeStartLocation, .drawsAfterEndLocation]
)

let upperGlow = CGGradient(
    colorsSpace: colorSpace,
    colors: [
        color(106, 120, 255, 0.36),
        color(106, 120, 255, 0.0)
    ] as CFArray,
    locations: [0.0, 1.0]
)!
context.drawRadialGradient(
    upperGlow,
    startCenter: CGPoint(x: 260, y: 130),
    startRadius: 0,
    endCenter: CGPoint(x: 260, y: 130),
    endRadius: 610,
    options: []
)

let lowerGlow = CGGradient(
    colorsSpace: colorSpace,
    colors: [
        color(49, 224, 205, 0.28),
        color(49, 224, 205, 0.0)
    ] as CFArray,
    locations: [0.0, 1.0]
)!
context.drawRadialGradient(
    lowerGlow,
    startCenter: CGPoint(x: 830, y: 805),
    startRadius: 0,
    endCenter: CGPoint(x: 830, y: 805),
    endRadius: 540,
    options: []
)

let cortexPath = arcPath(
    center: CGPoint(x: 512, y: 512),
    radius: 288,
    startDegrees: 58,
    endDegrees: 302,
    segments: 180
)

context.saveGState()
context.setShadow(offset: CGSize(width: 0, height: 24), blur: 36, color: color(0, 0, 0, 0.34))
context.addPath(cortexPath)
context.setLineWidth(166)
context.setLineCap(.round)
context.setLineJoin(.round)
context.setStrokeColor(color(220, 255, 253, 0.85))
context.strokePath()
context.restoreGState()

strokeGradient(
    context,
    path: cortexPath,
    lineWidth: 154,
    colors: [
        color(246, 254, 255),
        color(187, 255, 246),
        color(117, 231, 222)
    ],
    locations: [0.0, 0.58, 1.0],
    start: CGPoint(x: 280, y: 215),
    end: CGPoint(x: 725, y: 810)
)

let foldColor = color(12, 67, 78, 0.52)
context.saveGState()
context.addPath(cortexPath)
context.setLineWidth(154)
context.setLineCap(.round)
context.setLineJoin(.round)
context.replacePathWithStrokedPath()
context.clip()

context.setLineCap(.round)
context.setLineJoin(.round)
context.setStrokeColor(foldColor)
context.setLineWidth(28)

let topFold = CGMutablePath()
topFold.move(to: CGPoint(x: 500, y: 249))
topFold.addCurve(
    to: CGPoint(x: 338, y: 424),
    control1: CGPoint(x: 404, y: 270),
    control2: CGPoint(x: 337, y: 328)
)
context.addPath(topFold)
context.strokePath()

let lowerFold = CGMutablePath()
lowerFold.move(to: CGPoint(x: 323, y: 539))
lowerFold.addCurve(
    to: CGPoint(x: 512, y: 675),
    control1: CGPoint(x: 354, y: 628),
    control2: CGPoint(x: 423, y: 674)
)
context.addPath(lowerFold)
context.strokePath()

context.restoreGState()

let arrowPath = CGMutablePath()
let arrowBody = CGPath(
    roundedRect: CGRect(x: 620, y: 462, width: 196, height: 100),
    cornerWidth: 50,
    cornerHeight: 50,
    transform: nil
)
arrowPath.addPath(arrowBody)
arrowPath.move(to: CGPoint(x: 508, y: 512))
arrowPath.addLine(to: CGPoint(x: 650, y: 407))
arrowPath.addLine(to: CGPoint(x: 650, y: 617))
arrowPath.closeSubpath()

context.saveGState()
context.setShadow(offset: CGSize(width: 0, height: 18), blur: 28, color: color(0, 0, 0, 0.28))
context.addPath(arrowPath)
context.setFillColor(color(178, 255, 242))
context.fillPath()
context.restoreGState()

fillGradient(
    context,
    path: arrowPath,
    colors: [
        color(239, 255, 249),
        color(124, 246, 224),
        color(69, 207, 199)
    ],
    locations: [0.0, 0.54, 1.0],
    start: CGPoint(x: 505, y: 420),
    end: CGPoint(x: 820, y: 620)
)

let intakeCore = CGPath(
    ellipseIn: CGRect(x: 478, y: 478, width: 68, height: 68),
    transform: nil
)
context.saveGState()
context.addPath(intakeCore)
context.setFillColor(color(10, 48, 60, 0.82))
context.fillPath()
context.restoreGState()

context.saveGState()
context.addPath(intakeCore)
context.setLineWidth(12)
context.setStrokeColor(color(226, 255, 249, 0.72))
context.strokePath()
context.restoreGState()

guard let image = context.makeImage() else {
    fatalError("Could not create image")
}

let scriptURL = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL
let scriptDirectory = scriptURL.deletingLastPathComponent()
let repositoryRoot: URL
if scriptDirectory.lastPathComponent == "scripts" {
    repositoryRoot = scriptDirectory.deletingLastPathComponent()
} else {
    repositoryRoot = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
}

let outputURL = repositoryRoot
    .appendingPathComponent("CortexApp")
    .appendingPathComponent("Assets.xcassets")
    .appendingPathComponent("AppIcon.appiconset")
    .appendingPathComponent("icon-1024.png")

try FileManager.default.createDirectory(
    at: outputURL.deletingLastPathComponent(),
    withIntermediateDirectories: true
)

guard let destination = CGImageDestinationCreateWithURL(outputURL as CFURL, "public.png" as CFString, 1, nil) else {
    fatalError("Could not create PNG destination")
}

CGImageDestinationAddImage(destination, image, [
    kCGImagePropertyPNGDictionary: [
        kCGImagePropertyPNGInterlaceType: 0
    ]
] as CFDictionary)

if !CGImageDestinationFinalize(destination) {
    fatalError("Could not write PNG")
}

print("Wrote \(outputURL.path)")
