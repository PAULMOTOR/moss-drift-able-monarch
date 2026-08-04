/**
 * Generate a real PDF buffer for a Paul Motor lease quote (pdf-lib — pure JS, Vercel-safe).
 * When acceptedOption is set, only that option is drawn (Drive / accepted packet).
 */
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { ClientQuoteInfo, LeaseOptionResult } from "./lease-quote";
import { formatMoney } from "./lease-quote";
import { palmettoLogoJpegBytes } from "./palmetto-logo-bytes";

function money(n: number) {
  return formatMoney(n);
}

/** Zero out non-selected options so the multi-col filter hides them. */
export function onlyAcceptedOptions(
  options: LeaseOptionResult[],
  acceptedOption: number,
): LeaseOptionResult[] {
  return options.map((o, i) =>
    i === acceptedOption - 1
      ? o
      : {
          ...o,
          cost: 0,
          extra: 0,
          profit: 0,
          tradeIn: 0,
          deposit: 0,
          residual: 0,
          payment: 0,
          taxOnPayment: 0,
          totalPayment: 0,
          dueTotal: 0,
          proRata: 0,
          dueSubtotal: 0,
          dueTax: 0,
          yieldPct: 0,
        },
  );
}

export async function buildRetailQuotePdf(
  client: ClientQuoteInfo,
  options: LeaseOptionResult[],
  _taxRate: number,
  opts?: { acceptedOption?: number | null; titleSuffix?: string },
): Promise<Buffer> {
  const acceptedOption = opts?.acceptedOption ?? null;
  const drawOptions =
    acceptedOption && acceptedOption >= 1 && acceptedOption <= 3
      ? onlyAcceptedOptions(options, acceptedOption)
      : options;

  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]); // LETTER
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);

  const teal = rgb(0 / 255, 130 / 255, 114 / 255);
  const muted = rgb(96 / 255, 94 / 255, 92 / 255);
  const black = rgb(0.1, 0.1, 0.1);
  const margin = 44;
  const pageW = 612;
  const contentW = pageW - margin * 2;

  let y = 750;

  // Logo top-left (embedded asset — works on Vercel)
  let textX = margin;
  try {
    const logoBytes = palmettoLogoJpegBytes();
    const img = await doc.embedJpg(logoBytes);
    const logoH = 52;
    const logoW = (img.width / img.height) * logoH;
    page.drawImage(img, {
      x: margin,
      y: y - logoH + 6,
      width: logoW,
      height: logoH,
    });
    textX = margin + logoW + 14;
  } catch (e) {
    console.error("[quote-pdf] logo embed failed", e);
  }

  const mainTitle = acceptedOption
    ? `LEASE QUOTE — OPTION ${acceptedOption} ACCEPTED`
    : "LEASE QUOTE";
  page.drawText(mainTitle, {
    x: textX,
    y: y - 8,
    size: acceptedOption ? 13 : 18,
    font: fontBold,
    color: teal,
  });
  page.drawText(
    `PAUL MOTOR CO. · Valid for one week · ${client.quoteDate || ""}${opts?.titleSuffix ? ` · ${opts.titleSuffix}` : ""}`,
    {
      x: textX,
      y: y - 26,
      size: 9,
      font,
      color: muted,
    },
  );

  y -= 62;
  page.drawLine({
    start: { x: margin, y },
    end: { x: pageW - margin, y },
    thickness: 1.5,
    color: teal,
  });
  y -= 22;

  const vehicle = [client.year || "", client.make, client.model, client.trim]
    .filter(Boolean)
    .join(" ");

  const rows: [string, string, string, string][] = [
    ["PREPARED FOR", client.clientName || "—", "VEHICLE", vehicle || "—"],
    [
      "PHONE",
      client.phone || "—",
      "COLOUR / KM",
      `${client.color || "—"} · ${client.km != null ? client.km.toLocaleString("en-CA") : "—"} km`,
    ],
    [
      "EMAIL",
      client.email || "—",
      "VIN / STOCK",
      `${client.vin || "—"} · ${client.stock || "—"}`,
    ],
    ["SALESMAN", client.salesman || "—", "GUARANTOR", client.guarantor || "N/A"],
    [
      "LEASE START",
      client.startDate || "—",
      "KM ALLOWANCE",
      `${(client.kmPerYear || 0).toLocaleString("en-CA")} km/yr · ${money(client.excessKmFee || 0)}/km`,
    ],
  ];

  const colW = contentW / 2;
  for (const [l1, v1, l2, v2] of rows) {
    page.drawText(l1, { x: margin, y, size: 7, font, color: muted });
    page.drawText(l2, { x: margin + colW, y, size: 7, font, color: muted });
    y -= 12;
    page.drawText(String(v1).slice(0, 48), {
      x: margin,
      y,
      size: 10,
      font: fontBold,
      color: black,
    });
    page.drawText(String(v2).slice(0, 48), {
      x: margin + colW,
      y,
      size: 10,
      font: fontBold,
      color: black,
    });
    y -= 18;
  }

  y -= 8;

  const active = drawOptions
    .map((o, i) => ({ o, i: i + 1 }))
    .filter(({ o }) => o.cost > 0 || o.payment > 0);

  const singleMode = Boolean(acceptedOption) && active.length === 1;
  const boxW = singleMode ? Math.min(contentW, 320) : (contentW - 16) / 2;
  const boxH = 230;

  function drawOption(num: number, x: number, top: number) {
    const found = active.find((a) => a.i === num);
    if (!found) return;
    const o = found.o;
    page.drawRectangle({
      x,
      y: top - boxH,
      width: boxW,
      height: boxH,
      borderColor: rgb(0.78, 0.77, 0.77),
      borderWidth: 0.8,
    });
    const heading =
      acceptedOption === num ? `Option ${num} — ACCEPTED` : `Option ${num}`;
    page.drawText(heading, {
      x: x + 10,
      y: top - 16,
      size: 11,
      font: fontBold,
      color: teal,
    });
    const lines: [string, string, boolean?][] = [
      ["Price", money(o.cost + o.extra + o.profit)],
      ["Trade-In", money(o.tradeIn)],
      ["Cash-down", `${money(o.deposit)} (${o.depositPct.toFixed(1)}%)`],
      ["Term", `${o.termMonths} mo`],
      ["Residual", `${money(o.residual)} (${o.residualPct.toFixed(1)}%)`],
      ["Int. Rate", `${o.ratePct.toFixed(2)}%`],
      ["Yield", `${o.yieldPct.toFixed(2)}%`, true],
      ["Lease Payment", money(o.payment)],
      ["Taxes", money(o.taxOnPayment)],
      ["Total Payment", money(o.totalPayment), true],
      ["Due on delivery", money(o.dueTotal)],
      [
        "Pro-rata",
        `${money(o.proRata)} (${o.daysLeftMonth}/${o.daysInMonth} d)`,
      ],
    ];
    let ly = top - 32;
    for (const [lab, val, bold] of lines) {
      const f = bold ? fontBold : font;
      page.drawText(lab, { x: x + 10, y: ly, size: 9, font: f, color: black });
      const vw = font.widthOfTextAtSize(val, 9);
      page.drawText(val, {
        x: x + boxW - 10 - vw,
        y: ly,
        size: 9,
        font: f,
        color: black,
      });
      ly -= 13;
    }
    if (num === 3 || acceptedOption === num) {
      const note = `Rate/residual subject to credit approval. Valid one week. Excess km: ${money(client.excessKmFee)}/km over ${(client.kmPerYear || 0).toLocaleString("en-CA")} km/yr.`;
      page.drawText(note.slice(0, 95), {
        x: x + 10,
        y: top - boxH + 22,
        size: 6.5,
        font,
        color: muted,
        maxWidth: boxW - 20,
      });
      if (note.length > 95) {
        page.drawText(note.slice(95), {
          x: x + 10,
          y: top - boxH + 12,
          size: 6.5,
          font,
          color: muted,
          maxWidth: boxW - 20,
        });
      }
    }
  }

  const optTop = y;
  if (singleMode && acceptedOption) {
    drawOption(acceptedOption, margin, optTop);
  } else {
    drawOption(1, margin, optTop);
    drawOption(2, margin + boxW + 16, optTop);
    drawOption(3, margin, optTop - boxH - 12);
  }

  page.drawLine({
    start: { x: margin, y: 52 },
    end: { x: pageW - margin, y: 52 },
    thickness: 0.6,
    color: rgb(0.93, 0.92, 0.91),
  });
  page.drawText("PAUL MOTOR COMPANY INC. DBA PAUL MOTOR LEASING", {
    x: margin,
    y: 38,
    size: 8,
    font: fontBold,
    color: muted,
  });
  page.drawText(
    "4009 rue de Verdun, Montreal, QC H4G 1L1 · T: 514-767-0126 · www.paulmotor.com",
    {
      x: margin,
      y: 26,
      size: 8,
      font,
      color: muted,
    },
  );

  const bytes = await doc.save();
  return Buffer.from(bytes);
}

export function pdfDataUrl(buf: Buffer): string {
  return `data:application/pdf;base64,${buf.toString("base64")}`;
}
