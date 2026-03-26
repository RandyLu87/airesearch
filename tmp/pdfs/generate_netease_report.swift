import Foundation
import AppKit
import CoreGraphics

let outputPath = "/Users/user/Documents/airesearch/netease-cloud-music-investment-report-2026-02-24-v2.pdf"
let url = URL(fileURLWithPath: outputPath)

let pageWidth: CGFloat = 612
let pageHeight: CGFloat = 792
let margin: CGFloat = 24
let contentWidth: CGFloat = pageWidth - margin * 2

var mediaBox = CGRect(x: 0, y: 0, width: pageWidth, height: pageHeight)
guard let ctx = CGContext(url as CFURL, mediaBox: &mediaBox, nil) else {
    fatalError("Failed to create PDF context")
}

var cursorY: CGFloat = pageHeight - margin

func setGraphicsContext(_ ctx: CGContext) {
    let nsCtx = NSGraphicsContext(cgContext: ctx, flipped: false)
    NSGraphicsContext.current = nsCtx
}

func ensureSpace(_ height: CGFloat) {
    if cursorY - height < margin {
        ctx.endPDFPage()
        ctx.beginPDFPage(nil)
        setGraphicsContext(ctx)
        cursorY = pageHeight - margin
    }
}

func drawWrapped(_ text: String, font: NSFont, color: NSColor = .black, extraSpacing: CGFloat = 4) {
    let paragraph = NSMutableParagraphStyle()
    paragraph.lineBreakMode = .byWordWrapping
    let attr: [NSAttributedString.Key: Any] = [
        .font: font,
        .foregroundColor: color,
        .paragraphStyle: paragraph
    ]
    let attributed = NSAttributedString(string: text, attributes: attr)
    let bounds = attributed.boundingRect(with: NSSize(width: contentWidth, height: .greatestFiniteMagnitude), options: [.usesLineFragmentOrigin, .usesFontLeading])
    let h = ceil(bounds.height)
    ensureSpace(h + extraSpacing)
    let drawRect = CGRect(x: margin, y: cursorY - h, width: contentWidth, height: h)
    attributed.draw(with: drawRect, options: [.usesLineFragmentOrigin, .usesFontLeading])
    cursorY -= h + extraSpacing
}

func drawSectionTitle(_ text: String) {
    drawWrapped(text, font: NSFont.boldSystemFont(ofSize: 12), extraSpacing: 6)
}

func drawTable(headers: [String], rows: [[String]], colWidths: [CGFloat], fontSize: CGFloat = 8.5) {
    let headerFont = NSFont.boldSystemFont(ofSize: fontSize)
    let bodyFont = NSFont.systemFont(ofSize: fontSize)
    let lineColor = NSColor(calibratedWhite: 0.75, alpha: 1)

    let rowHeight: CGFloat = 26
    let headerHeight: CGFloat = 30
    let tableWidth = colWidths.reduce(0, +)

    func drawRow(_ cells: [String], yTop: CGFloat, height: CGFloat, isHeader: Bool) {
        var x = margin
        for (i, cell) in cells.enumerated() {
            let w = colWidths[i]
            let rect = CGRect(x: x, y: yTop - height, width: w, height: height)
            ctx.setStrokeColor(lineColor.cgColor)
            ctx.stroke(rect)

            if isHeader {
                ctx.setFillColor(NSColor(calibratedWhite: 0.95, alpha: 1).cgColor)
                ctx.fill(rect.insetBy(dx: 0.5, dy: 0.5))
                ctx.setStrokeColor(lineColor.cgColor)
                ctx.stroke(rect)
            }

            let paragraph = NSMutableParagraphStyle()
            paragraph.lineBreakMode = .byWordWrapping
            paragraph.alignment = .left
            let attr: [NSAttributedString.Key: Any] = [
                .font: isHeader ? headerFont : bodyFont,
                .foregroundColor: NSColor.black,
                .paragraphStyle: paragraph
            ]
            let attributed = NSAttributedString(string: cell, attributes: attr)
            let textRect = rect.insetBy(dx: 4, dy: 4)
            attributed.draw(with: textRect, options: [.usesLineFragmentOrigin, .usesFontLeading])

            x += w
        }
    }

    ensureSpace(headerHeight + CGFloat(rows.count) * rowHeight + 10)
    if tableWidth > contentWidth + 0.1 {
        drawWrapped("[Layout warning: table width exceeds content width]", font: NSFont.systemFont(ofSize: 8), color: .red)
    }

    drawRow(headers, yTop: cursorY, height: headerHeight, isHeader: true)
    cursorY -= headerHeight
    for row in rows {
        drawRow(row, yTop: cursorY, height: rowHeight, isHeader: false)
        cursorY -= rowHeight
    }
    cursorY -= 8
}

ctx.beginPDFPage(nil)
setGraphicsContext(ctx)

drawWrapped("NetEase Cloud Music (9899.HK) Financial Research Report - v2", font: NSFont.boldSystemFont(ofSize: 15), extraSpacing: 2)
drawWrapped("Report date: 2026-02-24", font: NSFont.systemFont(ofSize: 10), extraSpacing: 10)

drawSectionTitle("1) Company and Coverage Scope")
drawWrapped("Fact: Company: Cloud Music Inc. (9899.HK). Coverage: latest available quarter plus FY2023-FY2025 annual comparison.", font: NSFont.systemFont(ofSize: 10))
drawWrapped("Fact: Data cutoff date: 2026-02-24. Reporting currency shown in table: RMB.", font: NSFont.systemFont(ofSize: 10), extraSpacing: 10)

drawSectionTitle("2) Source Log (official first)")
drawWrapped("Fact: HKEX annual results announcement (FY2025), published 2026-02-11: https://www1.hkexnews.hk/listedco/listconews/sehk/2026/0211/2026021101795.pdf", font: NSFont.systemFont(ofSize: 9.5))
drawWrapped("Fact: HKEX annual results announcement (FY2024), published 2025-02-20: https://www1.hkexnews.hk/listedco/listconews/sehk/2025/0220/2025022000337.pdf", font: NSFont.systemFont(ofSize: 9.5))
drawWrapped("Fact: HKEX interim results (1H2025), published 2025-08-14: https://www1.hkexnews.hk/listedco/listconews/sehk/2025/0814/2025081400332.pdf", font: NSFont.systemFont(ofSize: 9.5))
drawWrapped("Fact: NetEase IR Q3 2025 release, published 2025-11-13: https://ir.netease.com/news-releases/news-release-details/netease-reports-unaudited-third-quarter-2025-financial-results", font: NSFont.systemFont(ofSize: 9.5), extraSpacing: 10)

drawSectionTitle("3) Latest Period Snapshot")
let snapHeaders = ["Metric", "Latest", "YoY", "QoQ", "Type"]
let snapRows = [
    ["Cloud Music segment revenue (2025Q3)", "RMB 1.9 bn", "+1.2%", "N/A", "Fact"],
    ["FY2025 revenue", "RMB 7.76 bn", "-2.5%", "N/A", "Fact"],
    ["FY2025 gross margin", "33.8%", "+0.8ppt", "N/A", "Fact"],
    ["FY2025 operating profit", "RMB 1.62 bn", "+333.7%", "N/A", "Fact"],
    ["FY2025 adjusted net profit", "RMB 1.70 bn", "+114.7%", "N/A", "Fact"]
]
drawTable(headers: snapHeaders, rows: snapRows, colWidths: [220, 85, 70, 70, 70], fontSize: 8.8)

drawSectionTitle("4) Annual Core Metrics Comparison (Required)")
let annualHeaders = ["FY", "Rev", "YoY", "GM", "OpInc", "OpM", "NetInc", "EPSd", "OCF", "FCF", "Net D/C", "Dil Sh", "Notes"]
let annualRows = [
    ["2023", "7.86", "N/A", "29.3%", "N/A", "N/A", "1.25", "N/A", "N/A", "N/A", "N/A", "N/A", "Derived base year from FY2024 yoy disclosure; many fields not disclosed in source set"],
    ["2024", "7.95", "+1.1%", "33.0%", "N/A", "N/A", "1.69", "N/A", "N/A", "N/A", "N/A", "N/A", "From 2024 annual results announcement"],
    ["2025", "7.76", "-2.5%", "33.8%", "1.62", "20.9%", "1.70", "N/A", "N/A", "N/A", "N/A", "N/A", "From 2025 annual results announcement"]
]
drawWrapped("Unit note (Fact): Revenue/OpInc/NetInc in RMB bn. NetInc uses adjusted net profit where disclosed.", font: NSFont.systemFont(ofSize: 9))
drawTable(headers: annualHeaders, rows: annualRows, colWidths: [30, 46, 34, 34, 40, 34, 42, 30, 30, 30, 40, 34, 140], fontSize: 7.5)

drawSectionTitle("5) Quality and Risk Checks")
drawWrapped("Inference: Margin expansion is substantial in FY2024-FY2025, but revenue growth is weak. Sustainability depends on ARPU, paid ratio, and content ROI discipline.", font: NSFont.systemFont(ofSize: 10))
drawWrapped("Fact: Competition and content-cost rebound remain key risks; low topline momentum raises execution sensitivity.", font: NSFont.systemFont(ofSize: 10), extraSpacing: 10)

drawSectionTitle("6) Scenario View (Bull/Base/Bear)")
let scHeaders = ["Scenario", "Key assumptions", "Trigger"]
let scRows = [
    ["Bull", "Membership growth + ARPU expansion; social entertainment recovery", "Margin keeps improving while revenue returns to mid-single-digit growth"],
    ["Base", "Stable margins with low-single-digit revenue", "Cash generation remains resilient"],
    ["Bear", "Competition drives higher content and acquisition cost", "Revenue stagnates/declines with margin pressure"]
]
drawTable(headers: scHeaders, rows: scRows, colWidths: [70, 280, 238], fontSize: 8.5)

drawSectionTitle("7) Key Monitoring Items")
drawWrapped("Fact: Next items to monitor: next earnings release date, membership net adds, social entertainment recovery slope, and cost ratio trajectory.", font: NSFont.systemFont(ofSize: 10))
drawWrapped("Inference: Investment thesis remains profitability-driven, not high-growth-driven, until revenue re-acceleration is verified.", font: NSFont.systemFont(ofSize: 10), extraSpacing: 10)

drawWrapped("Disclaimer: This report is for research summary of public disclosures only and is not investment advice.", font: NSFont.systemFont(ofSize: 9), color: NSColor.darkGray)

ctx.endPDFPage()
ctx.closePDF()
print("Generated: \(outputPath)")
