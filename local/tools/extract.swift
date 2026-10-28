import Foundation
import PDFKit
import AppKit

// usage: extract paper.pdf outdir   -> outdir/layout.json + outdir/fig_pN_K.png
let a = CommandLine.arguments
let doc = PDFDocument(url: URL(fileURLWithPath: a[1]))!
let out = a[2]
let S: CGFloat = 3.0   // render scale for figures

func render(_ page: PDFPage) -> NSBitmapImageRep {
    let box = page.bounds(for: .mediaBox)
    let w = Int(box.width * S), h = Int(box.height * S)
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: w, pixelsHigh: h, bitsPerSample: 8,
                               samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                               colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    let ctx = NSGraphicsContext(bitmapImageRep: rep)!
    NSGraphicsContext.current = ctx
    ctx.cgContext.setFillColor(NSColor.white.cgColor)
    ctx.cgContext.fill(CGRect(x: 0, y: 0, width: w, height: h))
    ctx.cgContext.scaleBy(x: S, y: S)
    page.draw(with: .mediaBox, to: ctx.cgContext)
    NSGraphicsContext.restoreGraphicsState()
    return rep
}

var pagesOut: [[String: Any]] = []
for pi in 0..<doc.pageCount {
    let page = doc.page(at: pi)!
    let box = page.bounds(for: .mediaBox)
    var lines: [[String: Any]] = []
    var rects: [CGRect] = []
    if let sel = page.selection(for: box) {
        for ln in sel.selectionsByLine() {
            let r = ln.bounds(for: page)
            let s = (ln.string ?? "").trimmingCharacters(in: .newlines)
            if s.trimmingCharacters(in: .whitespaces).isEmpty { continue }
            rects.append(r)
            var size: CGFloat = 0, bold = false, italic = false
            if let at = ln.attributedString, at.length > 0,
               let f = at.attribute(.font, at: at.length / 2, effectiveRange: nil) as? NSFont {
                size = f.pointSize
                let n = f.fontName.lowercased()
                bold = n.contains("bold"); italic = n.contains("italic") || n.contains("oblique")
            }
            lines.append(["t": s, "x": r.minX, "top": box.height - r.maxY, "w": r.width, "h": r.height,
                          "size": size, "bold": bold, "italic": italic])
        }
    }
    // figures: render, white-out text lines, find ink bands
    let rep = render(page)
    let W = rep.pixelsWide, H = rep.pixelsHigh, bpr = rep.bytesPerRow
    let d = rep.bitmapData!
    for r in rects {
        let x0 = max(0, Int((r.minX - 3) * S)), x1 = min(W, Int((r.maxX + 3) * S))
        let y0 = max(0, Int((box.height - r.maxY - 3) * S)), y1 = min(H, Int((box.height - r.minY + 3) * S))
        if x0 >= x1 || y0 >= y1 { continue }
        for y in y0..<y1 { for x in x0..<x1 { let o = y * bpr + x * 4; d[o] = 255; d[o+1] = 255; d[o+2] = 255 } }
    }
    func dark(_ x: Int, _ y: Int) -> Bool { let o = y * bpr + x * 4; return Int(d[o]) + Int(d[o+1]) + Int(d[o+2]) < 450 }
    var rowInk = [Int](repeating: 0, count: H)
    let margin = Int(10 * S)   // ignore scan edges
    for y in margin..<(H - margin) { var c = 0; for x in margin..<(W - margin) where dark(x, y) { c += 1 }; rowInk[y] = c }
    var bands: [(Int, Int)] = []
    var start = -1, lastInk = -1000
    let gap = Int(14 * S)
    for y in 0..<H {
        if rowInk[y] > 2 {
            if start < 0 || y - lastInk > gap { if start >= 0 { bands.append((start, lastInk)) }; start = y }
            lastInk = y
        }
    }
    if start >= 0 { bands.append((start, lastInk)) }
    var figs: [[String: Any]] = []
    var k = 0
    for (y0, y1) in bands where y1 - y0 > Int(30 * S) {
        var x0 = W, x1 = 0, ink = 0
        for y in y0...y1 { for x in margin..<(W - margin) where dark(x, y) { x0 = min(x0, x); x1 = max(x1, x); ink += 1 } }
        if x1 - x0 < Int(30 * S) || ink < 800 { continue }
        k += 1
        let p = Int(4 * S)
        let cx0 = max(0, x0 - p), cy0 = max(0, y0 - p), cx1 = min(W, x1 + p), cy1 = min(H, y1 + p)
        // crop from a clean (un-masked) render so nothing is lost
        let clean = render(page)
        let cg = clean.cgImage!.cropping(to: CGRect(x: cx0, y: cy0, width: cx1 - cx0, height: cy1 - cy0))!
        let name = "fig_p\(pi + 1)_\(k).png"
        try! NSBitmapImageRep(cgImage: cg).representation(using: .png, properties: [:])!
            .write(to: URL(fileURLWithPath: "\(out)/\(name)"))
        figs.append(["file": name, "top": CGFloat(cy0) / S, "bottom": CGFloat(cy1) / S,
                     "left": CGFloat(cx0) / S, "right": CGFloat(cx1) / S])
        print("p\(pi + 1) fig \(k): \(cx1 - cx0)x\(cy1 - cy0) ink \(ink)")
    }
    pagesOut.append(["page": pi + 1, "width": box.width, "height": box.height, "lines": lines, "figures": figs])
}
let json = try! JSONSerialization.data(withJSONObject: pagesOut, options: [.prettyPrinted])
try! json.write(to: URL(fileURLWithPath: "\(out)/layout.json"))
