/**
 * Generate a real PDF buffer for a Paul Motor lease quote (pdfkit).
 */
import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ClientQuoteInfo, LeaseOptionResult } from "./lease-quote";
import { formatMoney } from "./lease-quote";

// pdfkit is CJS
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const PDFDocument = require("pdfkit") as typeof import("pdfkit");

function loadLogo(): Buffer | null {
  const candidates = [
    join(process.cwd(), "public", "palmetto-logo.jpg"),
    join(process.cwd(), "public", "palmetto.jpg"),
    join(process.cwd(), "public", "palmetto.png"),
    join(process.cwd(), ".vercel/output/static", "palmetto-logo.jpg"),
    join(process.cwd(), ".vercel/output/static", "palmetto.png"),
  ];
  for (const p of candidates) {
    try {
      if (existsSync(p)) return readFileSync(p);
    } catch {
      /* try next */
    }
  }
  return null;
}

function money(n: number) {
  return formatMoney(n);
}

export async function buildRetailQuotePdf(
  client: ClientQuoteInfo,
  options: LeaseOptionResult[],
  _taxRate: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: "LETTER",
        margins: { top: 40, bottom: 48, left: 44, right: 44 },
        info: {
          Title: `Lease Quote — ${client.clientName || "Client"}`,
          Author: "Paul Motor Co.",
          Subject: "Lease Quote",
        },
      });
      const chunks: Buffer[] = [];
      doc.on("data", (c: Buffer) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      const teal = "#008272";
      const muted = "#605e5c";
      const pageW = doc.page.width - doc.page.margins.left - doc.page.margins.right;

      // Header
      const logo = loadLogo();
      let textLeft = doc.page.margins.left;
      if (logo) {
        try {
          doc.image(logo, doc.page.margins.left, 36, { width: 52, height: 52 });
          textLeft = doc.page.margins.left + 62;
        } catch {
          /* skip logo */
        }
      }
      doc
        .fillColor(teal)
        .font("Helvetica-Bold")
        .fontSize(18)
        .text("LEASE QUOTE", textLeft, 40, { width: pageW - 70 });
      doc
        .fillColor(muted)
        .font("Helvetica")
        .fontSize(9)
        .text(
          `PAUL MOTOR CO. · Valid for one week · ${client.quoteDate || ""}`,
          textLeft,
          62,
          { width: pageW - 70 },
        );

      // Teal rule
      doc
        .moveTo(doc.page.margins.left, 100)
        .lineTo(doc.page.width - doc.page.margins.right, 100)
        .strokeColor(teal)
        .lineWidth(1.5)
        .stroke();

      const vehicle = [client.year || "", client.make, client.model, client.trim]
        .filter(Boolean)
        .join(" ");

      // Client / vehicle grid
      let y = 114;
      const colW = pageW / 2;
      const rows: [string, string, string, string][] = [
        ["Prepared for", client.clientName || "—", "Vehicle", vehicle || "—"],
        ["Phone", client.phone || "—", "Colour / KM", `${client.color || "—"} · ${client.km != null ? client.km.toLocaleString("en-CA") : "—"} km`],
        ["Email", client.email || "—", "VIN / Stock", `${client.vin || "—"} · ${client.stock || "—"}`],
        ["Salesman", client.salesman || "—", "Guarantor", client.guarantor || "N/A"],
        [
          "Lease start",
          client.startDate || "—",
          "KM allowance",
          `${(client.kmPerYear || 0).toLocaleString("en-CA")} km/yr · ${money(client.excessKmFee || 0)}/km over`,
        ],
      ];

      for (const [l1, v1, l2, v2] of rows) {
        doc.fillColor(muted).font("Helvetica").fontSize(8).text(l1.toUpperCase(), doc.page.margins.left, y);
        doc.fillColor("#1a1a1a").font("Helvetica-Bold").fontSize(10).text(v1, doc.page.margins.left, y + 11, {
          width: colW - 12,
        });
        doc.fillColor(muted).font("Helvetica").fontSize(8).text(l2.toUpperCase(), doc.page.margins.left + colW, y);
        doc
          .fillColor("#1a1a1a")
          .font("Helvetica-Bold")
          .fontSize(10)
          .text(v2, doc.page.margins.left + colW, y + 11, { width: colW - 12 });
        y += 32;
      }

      y += 8;

      // Options — 2-col: opt1 left, opt2 right, opt3 under opt1
      const active = options
        .map((o, i) => ({ o, i: i + 1 }))
        .filter(({ o }) => o.cost > 0 || o.payment > 0);

      const boxW = (pageW - 16) / 2;
      const boxH = 210;

      function drawOption(num: number, x: number, top: number) {
        const found = active.find((a) => a.i === num);
        if (!found) return;
        const o = found.o;
        doc.rect(x, top, boxW, boxH).strokeColor("#c8c6c4").lineWidth(0.8).stroke();
        doc
          .fillColor(teal)
          .font("Helvetica-Bold")
          .fontSize(11)
          .text(`Option ${num}`, x + 10, top + 10);

        const lines: [string, string, boolean?][] = [
          ["Price", money(o.cost + o.extra + o.profit)],
          ["Trade-In", money(o.tradeIn)],
          ["Cash-down", money(o.deposit)],
          ["Term", `${o.termMonths} mo`],
          ["Residual", money(o.residual)],
          ["Int. Rate", `${o.ratePct.toFixed(2)}%`],
          ["Lease Payment", money(o.payment)],
          ["Taxes", money(o.taxOnPayment)],
          ["Total Payment", money(o.totalPayment), true],
          ["Due on delivery", money(o.dueTotal)],
          ["Pro-rata", `${money(o.proRata)} (${o.daysLeftMonth}/${o.daysInMonth} d)`],
        ];
        let ly = top + 28;
        for (const [lab, val, bold] of lines) {
          doc
            .fillColor("#1a1a1a")
            .font(bold ? "Helvetica-Bold" : "Helvetica")
            .fontSize(9)
            .text(lab, x + 10, ly, { width: boxW * 0.45, continued: false });
          doc
            .font(bold ? "Helvetica-Bold" : "Helvetica")
            .text(val, x + 10, ly, { width: boxW - 20, align: "right" });
          ly += 14;
        }
        if (num === 3) {
          doc
            .fillColor(muted)
            .font("Helvetica")
            .fontSize(7)
            .text(
              `Rate and residual subject to credit approval and inventory. Quote valid one week. Excess km: ${money(client.excessKmFee)}/km over ${(client.kmPerYear || 0).toLocaleString("en-CA")} km/yr.`,
              x + 10,
              top + boxH - 36,
              { width: boxW - 20 },
            );
        }
      }

      drawOption(1, doc.page.margins.left, y);
      drawOption(2, doc.page.margins.left + boxW + 16, y);
      drawOption(3, doc.page.margins.left, y + boxH + 14);

      // Footer
      const footY = doc.page.height - 56;
      doc
        .moveTo(doc.page.margins.left, footY - 8)
        .lineTo(doc.page.width - doc.page.margins.right, footY - 8)
        .strokeColor("#edebe9")
        .lineWidth(0.8)
        .stroke();
      doc
        .fillColor(muted)
        .font("Helvetica-Bold")
        .fontSize(8)
        .text("PAUL MOTOR COMPANY INC. DBA PAUL MOTOR LEASING", doc.page.margins.left, footY);
      doc
        .font("Helvetica")
        .fontSize(8)
        .text(
          "4009 rue de Verdun, Montreal, QC H4G 1L1 · T: 514-767-0126 · www.paulmotor.com",
          doc.page.margins.left,
          footY + 12,
        );
      if (client.notes) {
        doc.text(client.notes, doc.page.margins.left, footY + 24, { width: pageW });
      }

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

export function pdfDataUrl(buf: Buffer): string {
  return `data:application/pdf;base64,${buf.toString("base64")}`;
}
