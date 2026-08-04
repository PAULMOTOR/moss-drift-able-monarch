/** YEAR / Month / deal folder under parent.
 * Path: parent / 0. SALES - ALL / 2026 / August 2026 / deal
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
  // Fail fast with a clear message if the OAuth account cannot see the parent.
  await assertParentFolderAccessible(root);

  // parent / 0. SALES - ALL / …
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
    // Case-insensitive scan for a SALES folder under parent
    const drive = driveClient();
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
        n === "sales" ||
        (n.includes("sales") && n.includes("0."))
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
    const drive = driveClient();
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
    path: `${salesNameUsed}/${yearName}/${monthNameUsed}/${params.folderName}`,
  };
}
