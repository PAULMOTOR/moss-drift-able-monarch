export async function probeDrive(): Promise<{
  ok: boolean;
  error?: string;
  parentId?: string;
  parentName?: string;
  accountEmail?: string;
  tokenUsed?: string;
  scopesHint?: string;
}> {
  try {
    if (!isDriveConfigured()) {
      return { ok: false, error: "missing_oauth_env" };
    }
    const parent = driveParentFolderId();
    const gmailTok = env("GMAIL_REFRESH_TOKEN");
    const driveTok = env("GOOGLE_DRIVE_REFRESH_TOKEN");
    // Prefer Gmail token first (user re-auths that one most often).
    // If both are set and differ, try each until parent is visible.
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
          const about = await drive.about.get({ fields: "user(emailAddress,displayName)" });
          accountEmail = about.data.user?.emailAddress || undefined;
        } catch {
          /* optional */
        }
        const meta = await drive.files.get({
          fileId: parent,
          fields: "id, name, mimeType, driveId, capabilities",
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
        (accountEmail ? ` (${accountEmail})` : "") +
        `. Confirm: (1) you are logged into Drive as that exact account and can open the folder URL, ` +
        `(2) token has full .../auth/drive (not only drive.file) — re-run scripts/gmail-oauth.mjs after adding that scope, ` +
        `(3) if GOOGLE_DRIVE_REFRESH_TOKEN is an OLD token, delete it in Vercel so GMAIL_REFRESH_TOKEN is used, or set both to the NEW token, ` +
        `(4) folder must be a real folder ID, not a shortcut.`;
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
