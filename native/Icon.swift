import AppKit
let size = 1024
let image = NSImage(size: NSSize(width: size, height: size))
image.lockFocus()
let background = NSBezierPath(roundedRect: NSRect(x: 40, y: 40, width: 944, height: 944), xRadius: 210, yRadius: 210)
NSGradient(starting: NSColor(calibratedRed: 0.49, green: 0.62, blue: 0.42, alpha: 1), ending: NSColor(calibratedRed: 0.12, green: 0.30, blue: 0.25, alpha: 1))!.draw(in: background, angle: -50)
let shadow = NSShadow(); shadow.shadowColor = NSColor.black.withAlphaComponent(0.22); shadow.shadowBlurRadius = 45; shadow.shadowOffset = NSSize(width: 18, height: -25); shadow.set()
let bean = NSBezierPath(roundedRect: NSRect(x: 338, y: 215, width: 348, height: 600), xRadius: 172, yRadius: 172)
NSGradient(colors: [NSColor(calibratedRed: 0.73, green: 0.79, blue: 0.60, alpha: 1), NSColor(calibratedRed: 0.92, green: 0.93, blue: 0.79, alpha: 1), NSColor(calibratedRed: 0.66, green: 0.74, blue: 0.51, alpha: 1)])!.draw(in: bean, angle: 10)
NSShadow().set()
NSColor.white.withAlphaComponent(0.4).setStroke(); bean.lineWidth = 3; bean.stroke()
NSColor(calibratedRed: 0.35, green: 0.44, blue: 0.29, alpha: 0.6).setFill()
NSBezierPath(roundedRect: NSRect(x: 466, y: 721, width: 92, height: 18), xRadius: 9, yRadius: 9).fill()
NSColor.white.withAlphaComponent(0.9).setFill(); NSBezierPath(ovalIn: NSRect(x: 503, y: 670, width: 18, height: 18)).fill()
let button = NSBezierPath(ovalIn: NSRect(x: 465, y: 310, width: 94, height: 94)); NSColor(calibratedRed: 0.55, green: 0.63, blue: 0.42, alpha: 0.5).setStroke(); button.lineWidth = 3; button.stroke()
image.unlockFocus()
let rep = NSBitmapImageRep(data: image.tiffRepresentation!)!
try rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
