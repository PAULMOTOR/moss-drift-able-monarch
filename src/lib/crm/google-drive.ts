import { Readable } from "node:stream";

/** Lazy-load googleapis (~25MB) only when Drive is actually used. */
type Google = typeof import("googleapis").google;
let googleApi: Google | null = null;
async function getGoogle(): Promise<Google> {
  if (!googleApi) {
    const mod = await import("googleapis");
    googleApi = mod.google;
  }
  return googleApi;
}

function env(key: string): string | undefined {
  const v = process.env[key]?.trim();
  return v || undefined;
}

/** Parent folder: Paul Motor lease apps root (user-provided). */
const DRIVE_PARENT_NEW = "1-z1m4cfJdCacDqjMQYf3PlW2kPqJxnlU";
const DRIVE_PARENT_OLD = "1i1GWsg6P_Va5yfyScVfFLmgcP9ruHvCL";

export function driveParentFolderId(): string {
  const e = env("GOOGLE_DRIVE_PARENT_FOLDER_ID");
  // Ignore stale Vercel env still pointing at the previous lease-apps root
  if (!e || e === DRIVE_PARENT_OLD) return DRIVE_PARENT_NEW;
  return e;
}

export function isDriveConfigured(): boolean {
  return Boolean(
    env("GMAIL_CLIENT_ID") &&
      env("GMAIL_CLIENT_SECRET") &&
      (env("GOOGLE_DRIVE_REFRESH_TOKEN") || env("GMAIL_REFRESH_TOKEN")),
  );
}

async function getAuth(prefer: "drive" | "gmail" | "auto" = "auto") {
  const clientId = env("GMAIL_CLIENT_ID");
  const clientSecret = env("GMAIL_CLIENT_SECRET");
  const driveTok = env("GOOGLE_DRIVE_REFRESH_TOKEN");
  const gmailTok = env("GMAIL_REFRESH_TOKEN");
  let refreshToken: string | undefined;
  // Prefer Gmail token (usually the one just re-authed with full drive scope).
  if (prefer === "drive") refreshToken = driveTok || gmailTok;
  else if (prefer === "gmail") refreshToken = gmailTok || driveTok;
  else refreshToken = gmailTok || driveTok;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "Google Drive not configured. Set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, and a refresh token with Drive scope (GOOGLE_DRIVE_REFRESH_TOKEN or GMAIL_REFRESH_TOKEN).",
    );
  }
  const google = await getGoogle();
  const oauth2 = new google.auth.OAuth2(clientId, clientSecret);
  oauth2.setCredentials({ refresh_token: refreshToken });
  return oauth2;
}

async function driveClient(prefer: "drive" | "gmail" | "auto" = "auto") {
  const google = await getGoogle();
  return google.drive({ version: "v3", auth: await getAuth(prefer) });
}

const FOLDER_MIME = "application/vnd.google-apps.folder";

async function findChildFolder(
  parentId: string,
  name: string,
): Promise<string | null> {
  const drive = await driveClient();
  const q = [
    `'${parentId}' in parents`,
    `name = '${name.replace(/'/g, "\\'")}'`,
    `mimeType = '${FOLDER_MIME}'`,
    "trashed = false",
  ].join(" and ");
  const res = await drive.files.list({
    q,
    fields: "files(id, name)",
    pageSize: 5,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return res.data.files?.[0]?.id || null;
}

async function createFolder(parentId: string, name: string): Promise<string> {
  const drive = await driveClient();
  const res = await drive.files.create({
    requestBody: {
      name,
      mimeType: FOLDER_MIME,
      parents: [parentId],
    },
    fields: "id, webViewLink",
    supportsAllDrives: true,
  });
  if (!res.data.id) throw new Error("Drive folder create failed");
  return res.data.id;
}

export async function ensureFolder(
  parentId: string,
  name: string,
): Promise<string> {
  const existing = await findChildFolder(parentId, name);
  if (existing) return existing;
  return createFolder(parentId, name);
}


/** Verify OAuth account can read the parent folder (full drive scope required). */
export async function assertParentFolderAccessible(parentId?: string): Promise<{
  id: string;
  name: string;
  accountEmail?: string;
}> {
  const parent = parentId || driveParentFolderId();
  if (!isDriveConfigured()) {
    throw new Error(
      "Google Drive is not configured. Set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, and GMAIL_REFRESH_TOKEN (with Drive access).",
    );
  }

  const gmailTok = env("GMAIL_REFRESH_TOKEN");
  const driveTok = env("GOOGLE_DRIVE_REFRESH_TOKEN");
  const attempts: { label: string; prefer: "gmail" | "drive" }[] = [];
  if (gmailTok) attempts.push({ label: "GMAIL_REFRESH_TOKEN", prefer: "gmail" });
  if (driveTok && driveTok !== gmailTok) {
    attempts.push({ label: "GOOGLE_DRIVE_REFRESH_TOKEN", prefer: "drive" });
  } else if (driveTok && !gmailTok) {
    attempts.push({ label: "GOOGLE_DRIVE_REFRESH_TOKEN", prefer: "drive" });
  }
  if (attempts.length === 0) {
    throw new Error(
      "No Drive refresh token set (GMAIL_REFRESH_TOKEN / GOOGLE_DRIVE_REFRESH_TOKEN).",
    );
  }

  let lastError = "";
  let accountEmail: string | undefined;

  for (const attempt of attempts) {
    try {
      const drive = await driveClient(attempt.prefer);
      try {
        const about = await drive.about.get({
          fields: "user(emailAddress,displayName)",
        });
        accountEmail = about.data.user?.emailAddress || undefined;
      } catch {
        /* optional */
      }
      const meta = await drive.files.get({
        fileId: parent,
        fields: "id, name, mimeType, capabilities",
        supportsAllDrives: true,
      });
      return {
        id: parent,
        name: meta.data.name || parent,
        accountEmail,
      };
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }

  const who =
    accountEmail ||
    "the Google account used for OAuth (usually client@paulmotorcompany.com)";
  if (/not found|404|File not found/i.test(lastError)) {
    throw new Error(
      `Drive parent folder not found for ${who}. Folder id: ${parent}. ` +
        `Fix: (1) Open the folder while logged in as ${who}. ` +
        `(2) Share the folder with ${who} as Editor if needed. ` +
        `(3) Re-run OAuth with FULL Drive scope (https://www.googleapis.com/auth/drive, not drive.file only) as ${who}, ` +
        `update GMAIL_REFRESH_TOKEN + GOOGLE_DRIVE_REFRESH_TOKEN in Vercel, Redeploy. ` +
        `Google returns "File not found" when the token cannot see the folder (scope or sharing).`,
    );
  }
  throw new Error(
    `Cannot open Drive parent folder ${parent} as ${who}: ${lastError.slice(0, 300)}`,
  );
}

/** YEAR / Month / deal under: parent / 0. SALES - ALL / 2026 / August 2026 / deal
 * Month folders match existing Drive convention: "August 2026"
 * (also reuses "08-August" or similar if already present).
 */
export async function ensureDealFolder(params: {
  year: number;
  monthIndex: number; // 0-11
  folderName: string;
}): Promise<{ folderId: string; folderUrl: string; path: string }> {
  const SALES_FOLDER = "0. SALES - ALL";
  const monthLong = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  const mi = params.monthIndex;
  const mon = monthLong[mi] || monthLong[new Date().getMonth()];
  const yearName = String(params.year);
  const preferredMonth = `${mon} ${yearName}`;
  const monthAliases = [
    preferredMonth,
    mon,
    `${String(mi + 1).padStart(2, "0")}-${mon}`,
    `${mon} ${String(params.year).slice(2)}`,
  ];

  const root = driveParentFolderId();
  await assertParentFolderAccessible(root);

  // parent / 0. SALES - ALL
  const salesAliases = [
    SALES_FOLDER,
    "0. SALES-ALL",
    "0.SALES - ALL",
    "SALES - ALL",
    "SALES",
  ];
  let salesId: string | null = null;
  let salesNameUsed = SALES_FOLDER;
  for (const alias of salesAliases) {
    const found = await findChildFolder(root, alias);
    if (found) {
      salesId = found;
      salesNameUsed = alias;
      break;
    }
  }
  if (!salesId) {
    const drive = await driveClient();
    const listed = await drive.files.list({
      q: `'${root}' in parents and mimeType = '${FOLDER_MIME}' and trashed = false`,
      fields: "files(id, name)",
      pageSize: 100,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    const hit = (listed.data.files || []).find((f) => {
      const n = (f.name || "").toLowerCase().trim();
      return (
        n === SALES_FOLDER.toLowerCase() ||
        n.includes("sales - all") ||
        (n.includes("sales") && n.startsWith("0."))
      );
    });
    if (hit?.id) {
      salesId = hit.id;
      salesNameUsed = hit.name || SALES_FOLDER;
    }
  }
  if (!salesId) {
    salesId = await createFolder(root, SALES_FOLDER);
    salesNameUsed = SALES_FOLDER;
  }

  let yearId = await findChildFolder(salesId, yearName);
  if (!yearId) yearId = await findChildFolder(salesId, `Year ${yearName}`);
  if (!yearId) yearId = await createFolder(salesId, yearName);

  let monthId: string | null = null;
  let monthNameUsed = preferredMonth;
  for (const alias of monthAliases) {
    const found = await findChildFolder(yearId, alias);
    if (found) {
      monthId = found;
      monthNameUsed = alias;
      break;
    }
  }
  if (!monthId) {
    const drive = await driveClient();
    const listed = await drive.files.list({
      q: `'${yearId}' in parents and mimeType = '${FOLDER_MIME}' and trashed = false`,
      fields: "files(id, name)",
      pageSize: 100,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    const monLower = mon.toLowerCase();
    const hit = (listed.data.files || []).find((f) => {
      const n = (f.name || "").toLowerCase().trim();
      return (
        n === preferredMonth.toLowerCase() ||
        n === monLower ||
        n.includes(`${monLower} ${params.year}`) ||
        n === `${String(mi + 1).padStart(2, "0")}-${monLower}`
      );
    });
    if (hit?.id) {
      monthId = hit.id;
      monthNameUsed = hit.name || preferredMonth;
    }
  }
  if (!monthId) {
    monthId = await createFolder(yearId, preferredMonth);
    monthNameUsed = preferredMonth;
  }

  const dealId = await ensureFolder(monthId, params.folderName);
  const drive = await driveClient();
  const meta = await drive.files.get({
    fileId: dealId,
    fields: "id, webViewLink",
    supportsAllDrives: true,
  });
  return {
    folderId: dealId,
    folderUrl:
      meta.data.webViewLink ||
      `https://drive.google.com/drive/folders/${dealId}`,
    path: `${salesNameUsed}/${yearName}/${monthNameUsed}/${params.folderName}`,
  };
}

export async function uploadFileToFolder(params: {
  folderId: string;
  fileName: string;
  mimeType: string;
  /** raw base64 (no data: prefix) or full data URL */
  data: string;
}): Promise<{ fileId: string; fileUrl: string }> {
  const drive = await driveClient();
  let b64 = params.data;
  if (b64.startsWith("data:")) {
    b64 = b64.split(",")[1] || "";
  }
  const body = Buffer.from(b64, "base64");
  const res = await drive.files.create({
    requestBody: {
      name: params.fileName,
      parents: [params.folderId],
    },
    media: {
      mimeType: params.mimeType,
      body: ReadableFrom(body),
    },
    fields: "id, webViewLink",
    supportsAllDrives: true,
  });
  if (!res.data.id) throw new Error("Drive file upload failed");
  return {
    fileId: res.data.id,
    fileUrl:
      res.data.webViewLink ||
      `https://drive.google.com/file/d/${res.data.id}/view`,
  };
}

/** Find a non-trashed file by exact name under a folder. */
export async function findFileInFolder(
  folderId: string,
  fileName: string,
): Promise<string | null> {
  const drive = await driveClient();
  const q = [
    `'${folderId}' in parents`,
    `name = '${fileName.replace(/'/g, "\\'")}'`,
    "trashed = false",
  ].join(" and ");
  const res = await drive.files.list({
    q,
    fields: "files(id, name)",
    pageSize: 5,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return res.data.files?.[0]?.id || null;
}

/**
 * Upload a file; if the same name already exists in the folder, replace its media
 * (keeps Push to Drive idempotent instead of stacking duplicates).
 */
export async function uploadOrReplaceFile(params: {
  folderId: string;
  fileName: string;
  mimeType: string;
  data: string;
}): Promise<{ fileId: string; fileUrl: string; replaced: boolean }> {
  const existingId = await findFileInFolder(params.folderId, params.fileName);
  let b64 = params.data;
  if (b64.startsWith("data:")) {
    b64 = b64.split(",")[1] || "";
  }
  // Also allow plain text (HTML) when not base64-looking
  let body: Buffer;
  if (!params.data.startsWith("data:") && !/^[A-Za-z0-9+/=\s]+$/.test(params.data.slice(0, 80))) {
    body = Buffer.from(params.data, "utf8");
  } else {
    body = Buffer.from(b64, "base64");
  }

  const drive = await driveClient();
  if (existingId) {
    const res = await drive.files.update({
      fileId: existingId,
      media: {
        mimeType: params.mimeType,
        body: ReadableFrom(body),
      },
      fields: "id, webViewLink",
      supportsAllDrives: true,
    });
    return {
      fileId: res.data.id || existingId,
      fileUrl:
        res.data.webViewLink ||
        `https://drive.google.com/file/d/${existingId}/view`,
      replaced: true,
    };
  }
  const created = await uploadFileToFolder({
    folderId: params.folderId,
    fileName: params.fileName,
    mimeType: params.mimeType,
    data:
      params.data.startsWith("data:") || /^[A-Za-z0-9+/=]+$/.test(b64.slice(0, 40))
        ? params.data.startsWith("data:")
          ? params.data
          : `data:${params.mimeType};base64,${b64}`
        : `data:${params.mimeType};base64,${Buffer.from(params.data, "utf8").toString("base64")}`,
  });
  return { ...created, replaced: false };
}

/** Sanitize a Drive file name (no path separators). */
export function safeDriveFileName(name: string, fallback = "file"): string {
  const n = String(name || fallback)
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
  return n || fallback;
}

/** Parse data URL → { mime, base64 data URL } */
export function normalizeUploadPayload(
  data: string,
  fallbackMime = "application/octet-stream",
): { mimeType: string; dataUrl: string } | null {
  if (!data || typeof data !== "string") return null;
  if (data.startsWith("data:")) {
    const m = data.match(/^data:([^;,]+)/);
    return { mimeType: m?.[1] || fallbackMime, dataUrl: data };
  }
  // raw base64
  if (data.length > 32) {
    return {
      mimeType: fallbackMime,
      dataUrl: `data:${fallbackMime};base64,${data}`,
    };
  }
  return null;
}

export function htmlToDataUrl(html: string): string {
  return `data:text/html;charset=utf-8;base64,${Buffer.from(html, "utf8").toString("base64")}`;
}

/** Minimal readable stream from Buffer without importing stream types awkwardly. */
function ReadableFrom(buf: Buffer) {
  return Readable.from(buf);
}

export function buildDealFolderName(parts: {
  year: number | null | undefined;
  make: string;
  model: string;
  trim: string;
  lessee: string;
  guarantor: string;
}): string {
  const vehicle = [parts.year, parts.make, parts.model, parts.trim]
    .map((x) => (x == null ? "" : String(x).trim()))
    .filter(Boolean)
    .join(" ");
  const lessee = (parts.lessee || "Client").trim();
  const guar = (parts.guarantor || "").trim();
  const right =
    guar && guar.toUpperCase() !== "N/A" ? `${lessee} (${guar})` : lessee;
  return `${vehicle || "Vehicle"} - ${right}`.replace(/\s+/g, " ").trim();
}

export function buildQuotePdfFileName(parts: {
  quoteDate: string;
  clientName: string;
  option: number;
  stock?: string;
  year?: number | null;
  make?: string;
  model?: string;
}): string {
  // Short: Q-YYMMDD-Last-O1.pdf  (or stock instead of last name)
  const now = new Date();
  let dt = now;
  const raw = (parts.quoteDate || "").trim();
  if (raw) {
    const parsed = Date.parse(raw);
    if (!Number.isNaN(parsed)) dt = new Date(parsed);
    else {
      const m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if (m) dt = new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2]));
    }
  }
  const yy = String(dt.getFullYear()).slice(2);
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  const yymmdd = `${yy}${mm}${dd}`;
  const last = (parts.clientName || "Client")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(-1)[0] || "Client";
  const client = last.replace(/[^a-zA-Z0-9]/g, "").slice(0, 10) || "Client";
  const stock = parts.stock
    ? parts.stock.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 8)
    : "";
  const tag = stock || client;
  return `Q-${yymmdd}-${tag}-O${parts.option}.pdf`;
}

export async function probeDrive(): Promise<{
  ok: boolean;
  error?: string;
  parentId?: string;
  parentName?: string;
  accountEmail?: string;
  tokenUsed?: string;
}> {
  try {
    if (!isDriveConfigured()) {
      return { ok: false, error: "missing_oauth_env" };
    }
    const parent = driveParentFolderId();
    const gmailTok = env("GMAIL_REFRESH_TOKEN");
    const driveTok = env("GOOGLE_DRIVE_REFRESH_TOKEN");
    const attempts: { label: string; prefer: "gmail" | "drive" }[] = [];
    if (gmailTok) attempts.push({ label: "GMAIL_REFRESH_TOKEN", prefer: "gmail" });
    if (driveTok && driveTok !== gmailTok) {
      attempts.push({ label: "GOOGLE_DRIVE_REFRESH_TOKEN", prefer: "drive" });
    } else if (driveTok && !gmailTok) {
      attempts.push({ label: "GOOGLE_DRIVE_REFRESH_TOKEN", prefer: "drive" });
    }
    if (attempts.length === 0) {
      return { ok: false, error: "missing_oauth_env", parentId: parent };
    }

    let lastError = "";
    let accountEmail: string | undefined;
    let tokenUsed: string | undefined;

    for (const attempt of attempts) {
      try {
        const drive = await driveClient(attempt.prefer);
        tokenUsed = attempt.label;
        try {
          const about = await drive.about.get({
            fields: "user(emailAddress,displayName)",
          });
          accountEmail = about.data.user?.emailAddress || undefined;
        } catch {
          /* optional */
        }
        const meta = await drive.files.get({
          fileId: parent,
          fields: "id, name, mimeType, driveId",
          supportsAllDrives: true,
        });
        return {
          ok: true,
          parentId: parent,
          parentName: meta.data.name || undefined,
          accountEmail,
          tokenUsed,
        };
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
      }
    }

    let hint = lastError;
    if (/not found|404|File not found/i.test(lastError)) {
      hint =
        `Parent folder ${parent} not visible to the OAuth account` +
        (accountEmail ? ` (${accountEmail})` : " (unknown email)") +
        ". Share with client@ as Editor; use full Drive scope; align GMAIL_REFRESH_TOKEN and GOOGLE_DRIVE_REFRESH_TOKEN.";
    }
    return {
      ok: false,
      error: hint,
      parentId: parent,
      accountEmail,
      tokenUsed,
    };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      parentId: driveParentFolderId(),
    };
  }
}
