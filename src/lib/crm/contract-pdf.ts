/**
 * Lease contract PDF (pdf-lib) for DocuSign / download after GSM approval.
 */
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { ClientQuoteInfo, LeaseOptionResult } from "./lease-quote";
import { formatMoney } from "./lease-quote";
import { palmettoLogoJpegBytes } from "./palmetto-logo-bytes";

function line(
  page: ReturnType<PDFDocument["addPage"]>,
  font: Awaited<ReturnType<PDFDocument["embedFont"]>>,
  text: string,
  x: number,
  y: number,
  size = 10,
  color = rgb(0.1, 0.1, 0.1),
) {
  page.drawText(text.slice(0, 110), { x, y, size, font, color });
}

export async function buildLeaseContractPdf(
  client: ClientQuoteInfo,
  option: LeaseOptionResult,
  taxRate: number,
): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const teal = rgb(0 / 255, 130 / 255, 114 / 255);
  const muted = rgb(0.38, 0.37, 0.36);
  const black = rgb(0.1, 0.1, 0.1);
  const margin = 48;
  const pageW = 612;
  const pageH = 792;
  let page = doc.addPage([pageW, pageH]);
  let y = pageH - margin;

  const ensure = (need: number) => {
    if (y - need < margin) {
      page = doc.addPage([pageW, pageH]);
      y = pageH - margin;
    }
  };

  try {
    const logoBytes = palmettoLogoJpegBytes();
    const img = await doc.embedJpg(logoBytes);
    const logoH = 40;
    const logoW = (img.width / img.height) * logoH;
    page.drawImage(img, { x: margin, y: y - logoH, width: logoW, height: logoH });
  } catch {
    /* logo optional */
  }

  line(page, bold, "LESSEE LEASE AGREEMENT", margin + 56, y - 12, 14, teal);
  y -= 28;
  line(page, bold, "PAUL MOTOR COMPANY INC. DBA PAUL MOTOR LEASING", margin, y, 9, black);
  y -= 12;
  line(page, font, "4009 rue de Verdun, Montreal, QC H4G 1L1 · 514-767-0126", margin, y, 8, muted);
  y -= 11;
  line(page, font, "GST 8630820380001 · QST 12081377070001", margin, y, 8, muted);
  y -= 18;

  const vehicle = [client.year, client.make, client.model, client.trim].filter(Boolean).join(" ");
  const endDate = (() => {
    const s = client.startDate ? new Date(client.startDate) : new Date();
    const e = new Date(s);
    e.setMonth(e.getMonth() + option.termMonths);
    return e.toISOString().slice(0, 10);
  })();
  const price = option.salePrice;

  const rows: Array<[string, string]> = [
    ["Lessee", client.clientName || "—"],
    ["Address", [client.address, client.city, client.province, client.postalCode].filter(Boolean).join(", ") || "—"],
    ["Phone / Email", [client.phone, client.email].filter(Boolean).join(" · ") || "—"],
    ["Guarantor(s)", client.guarantor || "N/A"],
    ["Vehicle", vehicle || "—"],
    ["VIN / Stock", `${client.vin || "—"} / ${client.stock || "—"}`],
    ["Colour / KM", `${client.color || "—"} / ${client.km != null ? `${client.km} km` : "—"}`],
    ["Term", `${option.termMonths} months (${client.startDate || "—"} → ${endDate})`],
    ["Selling / capitalized cost", formatMoney(price)],
    ["Cash down (down payment)", formatMoney(option.deposit)],
    ["Security deposit (refundable)", formatMoney(option.securityDeposit || 0)],
    ["Trade-in", formatMoney(option.tradeIn)],
    [
      "Trade vehicle",
      [
        [client.tradeYear, client.tradeMake, client.tradeModel, client.tradeTrim].filter(Boolean).join(" ") || null,
        client.tradeVin ? `VIN ${client.tradeVin}` : null,
        client.tradeKm != null ? `${client.tradeKm.toLocaleString("en-CA")} km` : null,
      ]
        .filter(Boolean)
        .join(" · ") || "—",
    ],
    ["Amount used in determining rent", formatMoney(option.financed)],
    ["Interest rate", `${option.ratePct.toFixed(2)}% per annum`],
    ["Basic monthly rent", formatMoney(option.payment)],
    [`Taxes on payment (${(taxRate * 100).toFixed(3)}%)`, formatMoney(option.taxOnPayment)],
    ["Total monthly rent", formatMoney(option.totalPayment)],
    ["Residual / purchase option", formatMoney(option.residual)],
    ["Pro-rata (delivery month)", formatMoney(option.proRata)],
    ["Total due on delivery (est.)", formatMoney(option.dueTotal)],
    ["KM allowance / excess", `${client.kmPerYear.toLocaleString("en-CA")} km/yr · ${formatMoney(client.excessKmFee)}/km`],
    ["Salesperson", client.salesman || "—"],
    ["Quote date", client.quoteDate || "—"],
  ];

  for (const [label, value] of rows) {
    ensure(16);
    line(page, bold, label, margin, y, 8, muted);
    line(page, font, value, margin + 200, y, 9, black);
    y -= 14;
  }

  y -= 8;
  ensure(80);
  line(page, bold, "Key terms (summary)", margin, y, 10, teal);
  y -= 14;
  const bullets = [
    "Lessee leases the Vehicle for the Term and pays monthly rent as stated above.",
    "Residual purchase option: residual amount + taxes + $200 transfer fee (unless amended in writing).",
    "Lessee must keep full insurance and maintain the Vehicle; no sale or encumbrance of the Vehicle.",
    "Default may lead to termination, repossession and recovery of amounts owing as permitted by law.",
    "Governed by the laws of the Lessee’s province (or Quebec if blank) and applicable federal laws.",
  ];
  for (const b of bullets) {
    ensure(28);
    const words = b.split(" ");
    let cur = "• ";
    for (const w of words) {
      const test = `${cur}${w} `;
      if (font.widthOfTextAtSize(test, 8) > pageW - margin * 2) {
        line(page, font, cur.trimEnd(), margin, y, 8, black);
        y -= 11;
        ensure(14);
        cur = `  ${w} `;
      } else {
        cur = test;
      }
    }
    if (cur.trim()) {
      line(page, font, cur.trimEnd(), margin, y, 8, black);
      y -= 13;
    }
  }

  y -= 20;
  ensure(90);
  line(page, bold, "SIGNATURES", margin, y, 10, teal);
  y -= 36;
  line(page, font, "______________________________", margin, y, 10, black);
  line(page, font, "______________________________", margin + 260, y, 10, black);
  y -= 12;
  line(page, font, "Lessee signature", margin, y, 8, muted);
  line(page, font, "Lessor — Paul Motor Leasing", margin + 260, y, 8, muted);
  y -= 28;
  line(page, font, "______________________________", margin, y, 10, black);
  y -= 12;
  line(page, font, `Guarantor (${client.guarantor || "if applicable"})`, margin, y, 8, muted);
  y -= 20;
  line(page, font, `Date: ______________    Executed at Montreal`, margin, y, 8, muted);

  const bytes = await doc.save();
  return Buffer.from(bytes);
}

export async function makeContractPdfDataUrl(
  client: ClientQuoteInfo,
  option: LeaseOptionResult,
  taxRate: number,
): Promise<{ pdfName: string; pdfData: string }> {
  const buf = await buildLeaseContractPdf(client, option, taxRate);
  const safe = (client.clientName || "Lessee").replace(/[^\w\-]+/g, "_").slice(0, 40);
  const pdfName = `Lease-Contract-${safe}-${client.vin || "VIN"}.pdf`.replace(/_+/g, "_");
  const pdfData = `data:application/pdf;base64,${buf.toString("base64")}`;
  return { pdfName, pdfData };
}
