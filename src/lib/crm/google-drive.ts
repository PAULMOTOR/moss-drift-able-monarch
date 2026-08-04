import { Readable } from "node:stream";
import { google } from "googleapis";

function env(key: string): string | undefined {
  const v = process.env[key]?.trim();
  return v || undefined;
}

/** Parent folder: Paul Motor lease apps root (user-provided). */
export function driveParentFolderId(): string {
  return (
    env("GOOGLE_DRIVE_PARENT_FOLDER_ID") ||
    "1i1GWsg6P_Va5yfyScVfFLmgcP9ruHvCL"
  );
}

export function isDriveConfigured(): boolean {
  return Boolean(
    env("GMAIL_CLIENT_ID") &&
      env("GMAIL_CLIENT_SECRET") &&
      (env("GOOGLE_DRIVE_REFRESH_TOKEN") || env("GMAIL_REFRESH_TOKEN")),
  );
}

function getAuth(prefer: "drive" | "gmail" | "auto" = "auto") {
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
  const oauth2 = new google.auth.OAuth2(clientId, clientSecret);
  oauth2.setCredentials({ refresh_token: refreshToken });
  return oauth2;
}

function driveClient(prefer: "drive" | "gmail" | "auto" = "auto") {
  return google.drive({ version: "v3", auth: getAuth(prefer) });
}

const FOLDER_MIME = "application/vnd.google-apps.folder";

async function findChildFolder(
  parentId: string,
  name: string,
): Promise<string | null> {
  const drive = driveClient();
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
  const drive = driveClient();
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

/** YEAR / Month name / deal folder under the configured parent. */
export async function ensureDealFolder(params: {
  year: number;
  monthIndex: number; // 0-11
  folderName: string;
}): Promise<{ folderId: string; folderUrl: string; path: string }> {
  const months = [
    "01-January",
    "02-February",
    "03-March",
    "04-April",
    "05-May",
    "06-June",
    "07-July",
    "08-August",
    "09-September",
    "10-October",
    "11-November",
    "12-December",
  ];
  const root = driveParentFolderId();
  const yearName = String(params.year);
  const monthName = months[params.monthIndex] || months[new Date().getMonth()];
  const yearId = await ensureFolder(root, yearName);
  const monthId = await ensureFolder(yearId, monthName);
  const dealId = await ensureFolder(monthId, params.folderName);
  const drive = driveClient();
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
    path: `${yearName}/${monthName}/${params.folderName}`,
  };
}

export async function uploadFileToFolder(params: {
  folderId: string;
  fileName: string;
  mimeType: string;
  /** raw base64 (no data: prefix) or full data URL */
  data: string;
}): Promise<{ fileId: string; fileUrl: string }> {
  const drive = driveClient();
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
  const d = (parts.quoteDate || new Date().toISOString().slice(0, 10)).replace(
    /[^0-9]/g,
    "",
  );
  const client = (parts.clientName || "Client")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .slice(0, 40);
  const veh = [parts.year, parts.make, parts.model]
    .filter(Boolean)
    .join("_")
    .replace(/[^a-zA-Z0-9_]+/g, "")
    .slice(0, 30);
  const stock = parts.stock ? `_Stk${parts.stock.replace(/[^a-zA-Z0-9-]/g, "")}` : "";
  return `PMC_Quote_${d}_${client}${veh ? `_${veh}` : ""}${stock}_Opt${parts.option}.pdf`;
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
        const drive = driveClient(attempt.prefer);
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
        ". Fix: delete OLD GOOGLE_DRIVE_REFRESH_TOKEN in Vercel if it differs from the new GMAIL_REFRESH_TOKEN; re-auth with full .../auth/drive; open folder as that same account; use real folder ID not a shortcut.";
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
