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
          tradeInLien: 0,
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
  const margin = 36;
  const pageW = 612;
  const contentW = pageW - margin * 2;

  let y = 750;
  const province = (client.province || "QC").trim().toUpperCase() || "QC";

  // Logo top-left (embedded asset — works on Vercel)
  let textX = margin;
  try {
    const logoBytes = palmettoLogoJpegBytes();
    const img = await doc.embedJpg(logoBytes);
    const logoH = 48;
    const logoW = (img.width / img.height) * logoH;
    page.drawImage(img, {
      x: margin,
      y: y - logoH + 6,
      width: logoW,
      height: logoH,
    });
    textX = margin + logoW + 12;
  } catch (e) {
    console.error("[quote-pdf] logo embed failed", e);
  }

  const mainTitle = acceptedOption
    ? `LEASE QUOTE — OPTION ${acceptedOption} ACCEPTED`
    : "LEASE QUOTE";
  page.drawText(mainTitle, {
    x: textX,
    y: y - 8,
    size: acceptedOption ? 12 : 16,
    font: fontBold,
    color: teal,
  });
  page.drawText(
    `PAUL MOTOR LEASING · Valid for one week · ${client.quoteDate || ""}${opts?.titleSuffix ? ` · ${opts.titleSuffix}` : ""}`,
    {
      x: textX,
      y: y - 24,
      size: 9,
      font,
      color: muted,
    },
  );

  y -= 56;
  page.drawLine({
    start: { x: margin, y },
    end: { x: pageW - margin, y },
    thickness: 1.5,
    color: teal,
  });
  y -= 18;

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

  const halfW = contentW / 2;
  for (const [l1, v1, l2, v2] of rows) {
    page.drawText(l1, { x: margin, y, size: 6.5, font, color: muted });
    page.drawText(l2, { x: margin + halfW, y, size: 6.5, font, color: muted });
    y -= 11;
    page.drawText(String(v1).slice(0, 42), {
      x: margin,
      y,
      size: 9,
      font: fontBold,
      color: black,
    });
    page.drawText(String(v2).slice(0, 42), {
      x: margin + halfW,
      y,
      size: 9,
      font: fontBold,
      color: black,
    });
    y -= 15;
  }

  y -= 6;

  const active = drawOptions
    .map((o, i) => ({ o, i: i + 1 }))
    .filter(({ o }) => o.cost > 0 || o.payment > 0);

  const singleMode = Boolean(acceptedOption) && active.length === 1;
  const gap = 8;
  // Three equal columns on one row (or one wide when single accepted)
  const colCount = singleMode ? 1 : Math.min(3, Math.max(1, active.length));
  const boxW = singleMode
    ? Math.min(contentW, 280)
    : (contentW - gap * (colCount - 1)) / 3;
  const lineSize = singleMode ? 8.5 : 7;
  const lineGap = singleMode ? 13 : 11.5;
  const headSize = singleMode ? 10 : 8.5;
  const boxH = singleMode ? 200 : 185;
  const padX = 6;
  const valueX = singleMode ? 95 : 72; // left-justified amounts column

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
      borderWidth: 0.7,
    });
    const heading =
      acceptedOption === num ? `Option ${num} — ACCEPTED` : `Option ${num}`;
    page.drawText(heading, {
      x: x + padX,
      y: top - 13,
      size: headSize,
      font: fontBold,
      color: teal,
    });
    const taxLabel =
      province === "BC"
        ? `GST 5%+PST ${(((o.pstRate ?? 0) * 100) || 0).toFixed(0)}%`
        : `Taxes (${province})`;
    const lines: [string, string, boolean?][] = [
      ["Price", money(o.cost + o.extra + o.profit)],
      ["Trade-In", money(o.tradeIn)],
      ["Trade Lien", money(o.tradeInLien || 0)],
      ["Cash-down", `${money(o.deposit)} (${o.depositPct.toFixed(1)}%)`],
      ["Term", `${o.termMonths} mo`],
      ["Residual", `${money(o.residual)} (${o.residualPct.toFixed(1)}%)`],
      ["Int. Rate", `${o.ratePct.toFixed(2)}%`],
      ["Lease Pmt", money(o.payment)],
      [taxLabel, money(o.taxOnPayment)],
      ["Total Pmt", money(o.totalPayment), true],
      ["Due deliv.", money(o.dueTotal)],
      [
        "Pro-rata",
        `${money(o.proRata)} (${o.daysLeftMonth}/${o.daysInMonth}d)`,
      ],
    ];
    let ly = top - 26;
    for (const [lab, val, bold] of lines) {
      const f = bold ? fontBold : font;
      page.drawText(lab, {
        x: x + padX,
        y: ly,
        size: lineSize,
        font: bold ? fontBold : font,
        color: black,
      });
      // Amounts left-justified (not right-aligned)
      page.drawText(val, {
        x: x + valueX,
        y: ly,
        size: lineSize,
        font: f,
        color: black,
      });
      ly -= lineGap;
    }
  }

  const optTop = y;
  if (singleMode && acceptedOption) {
    drawOption(acceptedOption, margin, optTop);
  } else {
    // Always lay out options 1–3 in one horizontal row when present
    const nums = active.map((a) => a.i).sort((a, b) => a - b);
    nums.forEach((num, idx) => {
      const x = margin + idx * (boxW + gap);
      drawOption(num, x, optTop);
    });
  }

  // Small print under options row
  const noteY = optTop - boxH - 14;
  const note = `Rate/residual subject to credit approval. Valid one week. Excess km: ${money(client.excessKmFee)}/km over ${(client.kmPerYear || 0).toLocaleString("en-CA")} km/yr. Tax province: ${province}.`;
  page.drawText(note.slice(0, 120), {
    x: margin,
    y: Math.max(noteY, 58),
    size: 6.5,
    font,
    color: muted,
    maxWidth: contentW,
  });
  if (note.length > 120) {
    page.drawText(note.slice(120), {
      x: margin,
      y: Math.max(noteY - 10, 48),
      size: 6.5,
      font,
      color: muted,
      maxWidth: contentW,
    });
  }

  page.drawLine({
    start: { x: margin, y: 42 },
    end: { x: pageW - margin, y: 42 },
    thickness: 0.6,
    color: rgb(0.93, 0.92, 0.91),
  });
  page.drawText("PAUL MOTOR COMPANY INC. DBA PAUL MOTOR LEASING", {
    x: margin,
    y: 30,
    size: 7.5,
    font: fontBold,
    color: muted,
  });
  page.drawText(
    "4009 rue de Verdun, Montreal, QC H4G 1L1 · T: 514-767-0126 · www.paulmotor.com",
    {
      x: margin,
      y: 18,
      size: 7.5,
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
