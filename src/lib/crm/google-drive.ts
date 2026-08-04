export async function probeDrive(): Promise<{
  ok: boolean;
  error?: string;
  parentId?: string;
  parentName?: string;
}> {
  try {
    if (!isDriveConfigured()) {
      return { ok: false, error: "missing_oauth_env" };
    }
    const drive = driveClient();
    const parent = driveParentFolderId();
    try {
      const meta = await drive.files.get({
        fileId: parent,
        fields: "id, name, mimeType",
        supportsAllDrives: true,
      });
      return {
        ok: true,
        parentId: parent,
        parentName: meta.data.name || undefined,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      let hint = msg;
      if (/not found|404|File not found/i.test(msg)) {
        hint =
          "Parent folder not visible to client@. Share it with client@paulmotorcompany.com as Editor. If already shared, re-run OAuth with full Drive scope (scripts/gmail-oauth.mjs) — drive.file alone cannot open an existing company folder.";
      }
      return { ok: false, error: hint, parentId: parent };
    }
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      parentId: driveParentFolderId(),
    };
  }
}
