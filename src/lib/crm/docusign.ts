/**
 * DocuSign eSignature (JWT grant) + optional Identity Verification (Live ID).
 *
 * Required Production env (from DocuSign Admin / Apps and Keys):
 *   DOCUSIGN_INTEGRATION_KEY   — Integration Key (Client ID)
 *   DOCUSIGN_USER_ID           — API Username (GUID) of the impersonated user
 *   DOCUSIGN_ACCOUNT_ID        — API Account ID (GUID)
 *   DOCUSIGN_RSA_PRIVATE_KEY   — RSA private key PEM (JWT auth). Paste with \n or real newlines.
 *   DOCUSIGN_AUTH_SERVER       — account.docusign.com (prod) or account-d.docusign.com (demo)
 *   DOCUSIGN_BASE_PATH         — e.g. https://na3.docusign.net or https://demo.docusign.net
 *
 * Optional (Live ID):
 *   DOCUSIGN_IDV_WORKFLOW_ID   — Identity Verification workflow ID from DocuSign Admin
 *
 * Optional:
 *   DOCUSIGN_CONNECT_SECRET    — HMAC secret if using Connect webhooks later
 */
import { SignJWT, importPKCS8 } from "jose";

export type DocuSignConfig = {
  integrationKey: string;
  userId: string;
  accountId: string;
  rsaPrivateKey: string;
  authServer: string;
  basePath: string;
  idvWorkflowId: string | null;
};

export function getDocuSignConfig(): DocuSignConfig | null {
  const integrationKey = process.env.DOCUSIGN_INTEGRATION_KEY?.trim() || "";
  const userId = process.env.DOCUSIGN_USER_ID?.trim() || "";
  const accountId = process.env.DOCUSIGN_ACCOUNT_ID?.trim() || "";
  let rsaPrivateKey = process.env.DOCUSIGN_RSA_PRIVATE_KEY?.trim() || "";
  // Allow keys stored with literal \n in Vercel
  if (rsaPrivateKey.includes("\\n")) {
    rsaPrivateKey = rsaPrivateKey.replace(/\\n/g, "\n");
  }
  const authServer =
    process.env.DOCUSIGN_AUTH_SERVER?.trim() || "account.docusign.com";
  const basePath =
    process.env.DOCUSIGN_BASE_PATH?.trim() || "https://na3.docusign.net";
  const idvWorkflowId = process.env.DOCUSIGN_IDV_WORKFLOW_ID?.trim() || null;

  if (!integrationKey || !userId || !accountId || !rsaPrivateKey) {
    return null;
  }
  return {
    integrationKey,
    userId,
    accountId,
    rsaPrivateKey,
    authServer,
    basePath: basePath.replace(/\/$/, ""),
    idvWorkflowId,
  };
}

export function docuSignConfigured(): boolean {
  return getDocuSignConfig() !== null;
}

export function docuSignStatus() {
  const cfg = getDocuSignConfig();
  return {
    configured: Boolean(cfg),
    idvReady: Boolean(cfg?.idvWorkflowId),
    authServer: cfg?.authServer || null,
    basePath: cfg?.basePath || null,
    missing: [
      !process.env.DOCUSIGN_INTEGRATION_KEY?.trim() && "DOCUSIGN_INTEGRATION_KEY",
      !process.env.DOCUSIGN_USER_ID?.trim() && "DOCUSIGN_USER_ID",
      !process.env.DOCUSIGN_ACCOUNT_ID?.trim() && "DOCUSIGN_ACCOUNT_ID",
      !process.env.DOCUSIGN_RSA_PRIVATE_KEY?.trim() && "DOCUSIGN_RSA_PRIVATE_KEY",
      !process.env.DOCUSIGN_BASE_PATH?.trim() && "DOCUSIGN_BASE_PATH (optional, defaults na3)",
      !process.env.DOCUSIGN_IDV_WORKFLOW_ID?.trim() &&
        "DOCUSIGN_IDV_WORKFLOW_ID (optional — Live ID)",
    ].filter(Boolean) as string[],
  };
}

async function getAccessToken(cfg: DocuSignConfig): Promise<string> {
  const key = await importPKCS8(cfg.rsaPrivateKey, "RS256");
  const now = Math.floor(Date.now() / 1000);
  const assertion = await new SignJWT({
    scope: "signature impersonation",
  })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(cfg.integrationKey)
    .setSubject(cfg.userId)
    .setAudience(cfg.authServer)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(key);

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
  });
  const res = await fetch(`https://${cfg.authServer}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(
      `DocuSign auth failed (${res.status}): ${err.slice(0, 300)}. ` +
        `Consent the integration once in DocuSign Admin (JWT consent).`,
    );
  }
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new Error("DocuSign auth returned no access_token");
  return json.access_token;
}

export type SendEnvelopeInput = {
  pdfBase64: string;
  fileName: string;
  emailSubject: string;
  signerName: string;
  signerEmail: string;
  guarantorName?: string | null;
  guarantorEmail?: string | null;
  /** When true and DOCUSIGN_IDV_WORKFLOW_ID is set, require Live ID before sign */
  requireIdv?: boolean;
};

export type SendEnvelopeResult = {
  envelopeId: string;
  status: string;
  uri: string | null;
  idvEnabled: boolean;
};

export async function sendLeaseContractEnvelope(
  input: SendEnvelopeInput,
): Promise<SendEnvelopeResult> {
  const cfg = getDocuSignConfig();
  if (!cfg) {
    throw new Error(
      "DocuSign is not configured. Add DOCUSIGN_INTEGRATION_KEY, DOCUSIGN_USER_ID, DOCUSIGN_ACCOUNT_ID, DOCUSIGN_RSA_PRIVATE_KEY (and DOCUSIGN_BASE_PATH) on Vercel Production.",
    );
  }
  const token = await getAccessToken(cfg);
  const useIdv = Boolean(input.requireIdv !== false && cfg.idvWorkflowId);

  const signers: Array<Record<string, unknown>> = [
    {
      email: input.signerEmail.trim().toLowerCase(),
      name: input.signerName.trim(),
      recipientId: "1",
      routingOrder: "1",
      tabs: {
        signHereTabs: [
          {
            documentId: "1",
            pageNumber: "1",
            xPosition: "72",
            yPosition: "680",
            optional: "false",
          },
        ],
        dateSignedTabs: [
          {
            documentId: "1",
            pageNumber: "1",
            xPosition: "280",
            yPosition: "690",
          },
        ],
      },
      ...(useIdv && cfg.idvWorkflowId
        ? {
            identityVerification: {
              workflowId: cfg.idvWorkflowId,
              steps: null,
              inputOptions: null,
            },
          }
        : {}),
    },
  ];

  if (input.guarantorEmail?.includes("@") && input.guarantorName?.trim()) {
    signers.push({
      email: input.guarantorEmail.trim().toLowerCase(),
      name: input.guarantorName.trim(),
      recipientId: "2",
      routingOrder: "2",
      tabs: {
        signHereTabs: [
          {
            documentId: "1",
            pageNumber: "1",
            xPosition: "400",
            yPosition: "680",
            optional: "false",
          },
        ],
      },
    });
  }

  const envelopeDefinition = {
    emailSubject: input.emailSubject.slice(0, 100),
    documents: [
      {
        documentBase64: input.pdfBase64.replace(/^data:application\/pdf;base64,/, ""),
        name: input.fileName || "Lease-Contract.pdf",
        fileExtension: "pdf",
        documentId: "1",
      },
    ],
    recipients: { signers },
    status: "sent",
  };

  const res = await fetch(
    `${cfg.basePath}/restapi/v2.1/accounts/${cfg.accountId}/envelopes`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(envelopeDefinition),
    },
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`DocuSign send failed (${res.status}): ${err.slice(0, 400)}`);
  }
  const json = (await res.json()) as {
    envelopeId?: string;
    status?: string;
    uri?: string;
  };
  if (!json.envelopeId) throw new Error("DocuSign returned no envelopeId");
  return {
    envelopeId: json.envelopeId,
    status: json.status || "sent",
    uri: json.uri
      ? `${cfg.basePath}/restapi/v2.1/accounts/${cfg.accountId}${json.uri.startsWith("/") ? "" : "/"}${json.uri}`
      : null,
    idvEnabled: useIdv,
  };
}
