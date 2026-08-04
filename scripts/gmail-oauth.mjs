#!/usr/bin/env node
/**
 * One-time helper: Gmail + Drive OAuth refresh token for client@paulmotorcompany.com
 *
 * Prerequisites:
 *  1. Google Cloud project with Gmail API + Google Drive API enabled
 *  2. OAuth Client ID (Desktop app) — client id + secret
 *  3. Data Access scopes: gmail.readonly + drive.file
 *
 * Usage (on your Mac, in the repo folder):
 *   GMAIL_CLIENT_ID=xxx.apps.googleusercontent.com \
 *   GMAIL_CLIENT_SECRET=yyy \
 *   node scripts/gmail-oauth.mjs
 *
 * Sign in as client@paulmotorcompany.com when the browser asks.
 * Copy the printed tokens into Vercel, then redeploy.
 */
import { createServer } from "node:http";
import { google } from "googleapis";

const clientId = process.env.GMAIL_CLIENT_ID?.trim();
const clientSecret = process.env.GMAIL_CLIENT_SECRET?.trim();

if (!clientId || !clientSecret) {
  console.error("Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET env vars first.");
  process.exit(1);
}

const REDIRECT = "http://127.0.0.1:53682/oauth2callback";
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  // Full Drive (not drive.file): app must create folders under an existing company parent
  // that was not created by this OAuth client. drive.file cannot see that parent.
  "https://www.googleapis.com/auth/drive",
];


const oauth2 = new google.auth.OAuth2(clientId, clientSecret, REDIRECT);
const url = oauth2.generateAuthUrl({
  access_type: "offline",
  prompt: "consent",
  scope: SCOPES,
  // Force account picker so you can pick client@paulmotorcompany.com
  include_granted_scopes: true,
});

console.log("\n1. Open this URL in a browser.");
console.log("   IMPORTANT: sign in as client@paulmotorcompany.com (not Jeremy).\n");
console.log(url);
console.log("\n2. Approve Gmail + Drive. This script will capture the redirect automatically.\n");

const server = createServer(async (req, res) => {
  try {
    const u = new URL(req.url || "/", REDIRECT);
    if (u.pathname !== "/oauth2callback") {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const code = u.searchParams.get("code");
    if (!code) {
      res.writeHead(400);
      res.end("Missing code");
      return;
    }
    const { tokens } = await oauth2.getToken(code);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(
      "<h1>Success</h1><p>You can close this tab and return to the terminal.</p>",
    );
    console.log("\n=== Paste these into Vercel Environment Variables (Production) ===\n");
    console.log(`GMAIL_CLIENT_ID=${clientId}`);
    console.log(`GMAIL_CLIENT_SECRET=${clientSecret}`);
    console.log(
      `GMAIL_REFRESH_TOKEN=${tokens.refresh_token || "(none — revoke access at myaccount.google.com/permissions and retry)"}`,
    );
    console.log(
      `GOOGLE_DRIVE_REFRESH_TOKEN=${tokens.refresh_token || "(same as above if one token)"}`,
    );
    console.log(`GMAIL_USER=client@paulmotorcompany.com`);
    console.log(
      `GOOGLE_DRIVE_PARENT_FOLDER_ID=1i1GWsg6P_Va5yfyScVfFLmgcP9ruHvCL`,
    );
    console.log("\nThen Redeploy Production on Vercel.\n");
    server.close();
    process.exit(0);
  } catch (e) {
    console.error(e);
    res.writeHead(500);
    res.end(String(e));
    process.exit(1);
  }
});

server.listen(53682, "127.0.0.1", () => {
  console.log("Listening on http://127.0.0.1:53682 for OAuth callback…");
});
