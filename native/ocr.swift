// Apple Vision OCR → JSON {"h":<imageHeight>,"boxes":[{text,conf,cx,cy,x,y,w,h}]} in TOP-LEFT pixel
// coords of the input image. Used by src/tools/ocr.ts to GROUND clicks on GA4/FileMaker (a custom
// canvas with no accessibility tree): find an element by its visible text and click the box Vision
// reports, instead of hardcoding coordinates that drift with the guest resolution.
//
// Recognition level: DEFAULT is .fast (~0.3s, ample for UI labels). Pass --accurate (~1.6s) only for
// a full-text dump / calibration where every character matters. `h` (image height) is echoed back so
// the caller can key its coordinate cache by resolution (image is always resized to 1200 wide, so the
// height encodes the guest aspect / resolution).
//
// Build: swiftc -O native/ocr.swift -o dist/native/ocr   (macOS; system frameworks, no deps)
// Run:   dist/native/ocr <image.png> [--accurate]

import Foundation
import Vision
import AppKit

let args = Array(CommandLine.arguments.dropFirst())
let accurate = args.contains("--accurate")
guard let path = args.first(where: { !$0.hasPrefix("--") }) else {
  FileHandle.standardError.write("usage: ocr <image.png> [--accurate]\n".data(using: .utf8)!); exit(2)
}
guard let img = NSImage(contentsOfFile: path),
      let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
  FileHandle.standardError.write("cannot load image: \(path)\n".data(using: .utf8)!); exit(1)
}
let W = Double(cg.width), H = Double(cg.height)
let req = VNRecognizeTextRequest()
req.recognitionLevel = accurate ? .accurate : .fast
req.usesLanguageCorrection = false
let handler = VNImageRequestHandler(cgImage: cg, options: [:])
do { try handler.perform([req]) } catch {
  FileHandle.standardError.write("vision error: \(error)\n".data(using: .utf8)!); exit(1)
}
var boxes: [[String: Any]] = []
for obs in (req.results ?? []) {
  guard let c = obs.topCandidates(1).first else { continue }
  let b = obs.boundingBox                       // normalized, BOTTOM-left origin
  let cx = (b.minX + b.width / 2) * W
  let cy = (1 - (b.minY + b.height / 2)) * H     // flip Y → top-left
  boxes.append([
    "text": c.string,
    "conf": Double(c.confidence),
    "cx": Int(cx.rounded()), "cy": Int(cy.rounded()),
    "x": Int((b.minX * W).rounded()), "y": Int(((1 - b.maxY) * H).rounded()),
    "w": Int((b.width * W).rounded()), "h": Int((b.height * H).rounded()),
  ])
}
let out: [String: Any] = ["h": Int(H), "boxes": boxes]
let data = try JSONSerialization.data(withJSONObject: out, options: [.sortedKeys])
print(String(data: data, encoding: .utf8)!)
