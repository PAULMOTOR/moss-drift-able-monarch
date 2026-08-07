import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  getPublicCreditApp,
  savePublicCreditApp,
  uploadPublicCreditDoc,
} from "@/lib/crm/credit";

export const Route = createFileRoute("/credit-app/$token")({
  component: PublicCreditAppPage,
});

type Step = "intro" | "individual" | "business_q" | "business" | "ids" | "done";

function PublicCreditAppPage() {
  const { token } = Route.useParams();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<Step>("intro");
  const [lead, setLead] = useState<{
    name: string;
    first_name: string | null;
    email: string | null;
    phone: string | null;
    vehicle_interest: string | null;
  } | null>(null);
  const [payload, setPayload] = useState<Record<string, string>>({});
  const [partyType, setPartyType] = useState<"individual" | "business">("individual");
  const [busy, setBusy] = useState(false);
  const [uploaded, setUploaded] = useState<string[]>([]);
  const [files, setFiles] = useState<Record<string, File | null>>({
    dl_front: null,
    dl_back: null,
    id_second: null,
  });

  useEffect(() => {
    void getPublicCreditApp({ data: { token } })
      .then((res) => {
        setLead(res.lead);
        setPayload({
          full_name: res.lead.name || "",
          first_name: res.lead.first_name || "",
          last_name: res.lead.last_name || "",
          email: res.lead.email || "",
          phone: res.lead.phone || "",
          ...(res.application.payload as Record<string, string>),
        });
        setPartyType(res.application.party_type || "individual");
        setUploaded(res.uploadedKinds);
        if (
          res.application.status === "app_submitted" ||
          res.application.status === "ids_uploaded" ||
          res.application.submitted_at
        ) {
          setStep(
            res.uploadedKinds.includes("dl_front") &&
              res.uploadedKinds.includes("dl_back") &&
              res.uploadedKinds.includes("id_second")
              ? "done"
              : "ids",
          );
        }
        setLoading(false);
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : "Invalid link");
        setLoading(false);
      });
  }, [token]);

  function setField(key: string, value: string) {
    setPayload((p) => ({ ...p, [key]: value }));
  }

  async function saveDraft(opts?: { submit?: boolean; already?: boolean }) {
    setBusy(true);
    try {
      await savePublicCreditApp({
        data: {
          token,
          payload,
          party_type: partyType,
          submit: opts?.submit,
          alreadySubmittedOnWeb: opts?.already,
        },
      });
      if (opts?.already) {
        setStep("ids");
        toast.success("Great — continue with ID upload");
      } else if (opts?.submit) {
        setStep("ids");
        toast.success("Application saved — please upload IDs");
      } else {
        toast.success("Saved");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  async function readFile(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(new Error("Read failed"));
      r.readAsDataURL(file);
    });
  }

  async function uploadOne(kind: string, file: File | null) {
    if (!file) return;
    setBusy(true);
    try {
      const data = await readFile(file);
      await uploadPublicCreditDoc({
        data: {
          token,
          kind: kind as "dl_front" | "dl_back" | "id_second",
          fileName: file.name,
          mimeType: file.type || "image/jpeg",
          fileData: data,
          via: "app",
        },
      });
      setUploaded((u) => Array.from(new Set([...u, kind])));
      toast.success(`${file.name} uploaded`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-[#f3f2f1] p-6">
        <p className="text-sm text-muted-foreground">Loading secure application…</p>
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-[#f3f2f1] p-6">
        <div className="max-w-md rounded-sm border bg-white p-6 text-center shadow-sm">
          <p className="font-semibold text-destructive">Link unavailable</p>
          <p className="mt-2 text-sm text-muted-foreground">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-dvh bg-[#f3f2f1]">
      <header className="border-b bg-[#008272] px-4 py-4 text-white">
        <div className="mx-auto max-w-3xl">
          <p className="text-xs font-semibold tracking-wide opacity-90">PAUL MOTOR LEASING</p>
          <h1 className="text-xl font-bold">Credit application</h1>
          {lead?.vehicle_interest ? (
            <p className="mt-1 text-sm opacity-90">Vehicle: {lead.vehicle_interest}</p>
          ) : null}
        </div>
      </header>

      <main className="mx-auto max-w-3xl space-y-4 p-4 pb-16">
        {step === "intro" ? (
          <CardBox title="Welcome">
            <p className="text-sm leading-relaxed text-muted-foreground">
              Please complete this short application and upload two pieces of ID. No password is
              required. Your documents are only visible to authorized Paul Motor staff.
            </p>
            <div className="mt-4 flex flex-col gap-2 sm:flex-row">
              <Button disabled={busy} onClick={() => setStep("individual")}>
                Start application
              </Button>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => void saveDraft({ already: true })}
              >
                I've already submitted it on PML's website
              </Button>
            </div>
          </CardBox>
        ) : null}

        {step === "individual" ? (
          <CardBox title="Individual applicant">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Full name *" value={payload.full_name} onChange={(v) => setField("full_name", v)} />
              <Field label="Phone *" value={payload.phone} onChange={(v) => setField("phone", v)} />
              <Field label="Email *" value={payload.email} onChange={(v) => setField("email", v)} />
              <Field label="SIN (optional)" value={payload.sin} onChange={(v) => setField("sin", v)} />
              <Field label="Date of birth *" type="date" value={payload.dob} onChange={(v) => setField("dob", v)} />
              <Field label="Current address *" value={payload.address} onChange={(v) => setField("address", v)} />
              <Field label="City *" value={payload.city} onChange={(v) => setField("city", v)} />
              <Field label="Postal code *" value={payload.postal} onChange={(v) => setField("postal", v)} />
              <Field label="Duration at address (years)" value={payload.addr_years} onChange={(v) => setField("addr_years", v)} />
              <Field label="Duration (months)" value={payload.addr_months} onChange={(v) => setField("addr_months", v)} />
              <Field label="Driver's licence No *" value={payload.dl_number} onChange={(v) => setField("dl_number", v)} />
              <Field label="Licence expiration *" type="date" value={payload.dl_exp} onChange={(v) => setField("dl_exp", v)} />
            </div>

            <h3 className="mt-6 text-sm font-semibold">Home</h3>
            <div className="mt-2 flex flex-col gap-2 text-sm">
              {["Rent", "Own w/ Mortgage", "Own Outright (No Mortgage)"].map((opt) => (
                <label key={opt} className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="home"
                    checked={payload.home_status === opt}
                    onChange={() => setField("home_status", opt)}
                  />
                  {opt}
                </label>
              ))}
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <Field label="Market value" value={payload.home_value} onChange={(v) => setField("home_value", v)} />
              <Field label="Mortgage amount" value={payload.mortgage_amt} onChange={(v) => setField("mortgage_amt", v)} />
              <Field label="Mortgage with" value={payload.mortgage_with} onChange={(v) => setField("mortgage_with", v)} />
              <Field label="Monthly payment" value={payload.mortgage_pmt} onChange={(v) => setField("mortgage_pmt", v)} className="sm:col-span-3" />
            </div>

            <h3 className="mt-6 text-sm font-semibold">Employment</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Current employment *" value={payload.employment} onChange={(v) => setField("employment", v)} />
              <Field label="Employer *" value={payload.employer} onChange={(v) => setField("employer", v)} />
              <Field label="Duration *" value={payload.emp_duration} onChange={(v) => setField("emp_duration", v)} />
              <Field label="Employer phone *" value={payload.emp_phone} onChange={(v) => setField("emp_phone", v)} />
              <Field label="Employer address *" value={payload.emp_address} onChange={(v) => setField("emp_address", v)} className="sm:col-span-2" />
              <Field label="Gross annual income *" value={payload.gross_income} onChange={(v) => setField("gross_income", v)} />
              <Field label="Other income *" value={payload.other_income} onChange={(v) => setField("other_income", v)} />
              <Field label="Income notes" value={payload.income_notes} onChange={(v) => setField("income_notes", v)} className="sm:col-span-2" />
            </div>

            <div className="mt-6 flex flex-wrap gap-2">
              <Button variant="outline" disabled={busy} onClick={() => void saveDraft()}>
                Save draft
              </Button>
              <Button
                disabled={busy}
                onClick={async () => {
                  await saveDraft();
                  setStep("business_q");
                }}
              >
                Continue
              </Button>
            </div>
          </CardBox>
        ) : null}

        {step === "business_q" ? (
          <CardBox title="Business lease?">
            <p className="text-sm text-muted-foreground">
              Will you be leasing under a business name?
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button
                onClick={() => {
                  setPartyType("business");
                  setStep("business");
                }}
              >
                Yes — business lease
              </Button>
              <Button
                variant="outline"
                onClick={async () => {
                  setPartyType("individual");
                  await saveDraft({ submit: true });
                }}
              >
                No — individual only
              </Button>
            </div>
          </CardBox>
        ) : null}

        {step === "business" ? (
          <CardBox title="Business information">
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Primary business activities *" value={payload.biz_activities} onChange={(v) => setField("biz_activities", v)} className="sm:col-span-3" />
              <Field label="Legal name *" value={payload.biz_legal} onChange={(v) => setField("biz_legal", v)} />
              <Field label="Operating name *" value={payload.biz_operating} onChange={(v) => setField("biz_operating", v)} />
              <Field label="Province *" value={payload.biz_province} onChange={(v) => setField("biz_province", v)} />
              {/^\s*(ON|Ontario)\s*$/i.test(payload.biz_province || "") ? (
                <Field
                  label="RIN Number (Ontario)"
                  value={payload.biz_rin}
                  onChange={(v) => setField("biz_rin", v)}
                  className="sm:col-span-3"
                />
              ) : (
                <div className="sm:col-span-3 rounded-sm border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                  RIN is only required for Ontario businesses. If this business has never registered a
                  vehicle in ON, they will not have a RIN — that can block registration; note it for
                  the credit team.
                </div>
              )}
            </div>
            <h3 className="mt-4 text-sm font-semibold">Company address</h3>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Postal code *" value={payload.biz_postal} onChange={(v) => setField("biz_postal", v)} />
              <Field label="Address type *" value={payload.biz_addr_type} onChange={(v) => setField("biz_addr_type", v)} />
              <Field label="Number, street *" value={payload.biz_street} onChange={(v) => setField("biz_street", v)} />
              <Field label="Suite" value={payload.biz_suite} onChange={(v) => setField("biz_suite", v)} />
              <Field label="City *" value={payload.biz_city} onChange={(v) => setField("biz_city", v)} />
              <Field label="Direction" value={payload.biz_direction} onChange={(v) => setField("biz_direction", v)} />
              <Field label="Duration" value={payload.biz_duration} onChange={(v) => setField("biz_duration", v)} />
              <Field label="Contact first & last name *" value={payload.biz_contact} onChange={(v) => setField("biz_contact", v)} />
              <Field label="Contact email *" value={payload.biz_contact_email} onChange={(v) => setField("biz_contact_email", v)} />
              <Field label="Contact phone *" value={payload.biz_contact_phone} onChange={(v) => setField("biz_contact_phone", v)} />
            </div>
            <h3 className="mt-4 text-sm font-semibold">Mailing address</h3>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Number, street *" value={payload.mail_street} onChange={(v) => setField("mail_street", v)} />
              <Field label="Suite" value={payload.mail_suite} onChange={(v) => setField("mail_suite", v)} />
              <Field label="City *" value={payload.mail_city} onChange={(v) => setField("mail_city", v)} />
              <Field label="Postal code *" value={payload.mail_postal} onChange={(v) => setField("mail_postal", v)} />
              <Field label="Province *" value={payload.mail_province} onChange={(v) => setField("mail_province", v)} />
            </div>
            <div className="mt-6 flex gap-2">
              <Button variant="outline" onClick={() => setStep("business_q")}>
                Back
              </Button>
              <Button disabled={busy} onClick={() => void saveDraft({ submit: true })}>
                Submit application & continue to IDs
              </Button>
            </div>
          </CardBox>
        ) : null}

        {step === "ids" ? (
          <CardBox title="Upload identification">
            <p className="mb-3 text-sm text-muted-foreground">
              1) Driver's licence — front & back. 2) Second ID: passport, PR card, or
              provincial health card.
            </p>
            <IdUpload
              label="Driver's licence — front"
              done={uploaded.includes("dl_front")}
              onFile={(f) => {
                setFiles((x) => ({ ...x, dl_front: f }));
                void uploadOne("dl_front", f);
              }}
            />
            <IdUpload
              label="Driver's licence — back"
              done={uploaded.includes("dl_back")}
              onFile={(f) => {
                setFiles((x) => ({ ...x, dl_back: f }));
                void uploadOne("dl_back", f);
              }}
            />
            <IdUpload
              label="Second ID (passport / PR / health card)"
              done={uploaded.includes("id_second")}
              onFile={(f) => {
                setFiles((x) => ({ ...x, id_second: f }));
                void uploadOne("id_second", f);
              }}
            />

            <div className="mt-6 rounded-sm border border-border bg-muted/40 p-3 text-xs leading-relaxed">
              <p className="font-semibold">Applicant Authorization and Certification</p>
              <p className="mt-2 text-muted-foreground">
                By clicking "Submit" below, I certify that the identification provided is
                legally mine and that all information entered in this credit application is true,
                accurate, and complete to the best of my knowledge. I hereby authorize{" "}
                <strong>Paul Motor Leasing</strong> to securely and confidentially verify the
                information provided for the purpose of evaluating my eligibility for vehicle
                leasing and credit approval. I understand and agree that this verification process
                may include obtaining a consumer credit report (credit check) from one or more
                credit reporting agencies. I acknowledge that this credit inquiry may impact my
                credit score. All data collected will be handled in strict accordance with
                applicable privacy laws and our Privacy Policy.
              </p>
            </div>
            <Button
              className="mt-4"
              disabled={
                busy ||
                !uploaded.includes("dl_front") ||
                !uploaded.includes("dl_back") ||
                !uploaded.includes("id_second")
              }
              onClick={() => {
                setStep("done");
                toast.success("Thank you — application package received");
              }}
            >
              Submit
            </Button>
          </CardBox>
        ) : null}

        {step === "done" ? (
          <CardBox title="Thank you">
            <p className="text-sm text-muted-foreground">
              Your application and IDs have been received by Paul Motor Leasing. A sales
              representative will follow up shortly. You may close this window.
            </p>
          </CardBox>
        ) : null}
      </main>
    </div>
  );
}

function CardBox({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-sm border border-border bg-white p-4 shadow-sm sm:p-6">
      <h2 className="mb-3 font-display text-lg font-semibold text-[#008272]">{title}</h2>
      {children}
    </section>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  className,
}: {
  label: string;
  value?: string;
  onChange: (v: string) => void;
  type?: string;
  className?: string;
}) {
  return (
    <div className={className}>
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Input
        type={type}
        className="mt-1 h-10"
        value={value || ""}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

function IdUpload({
  label,
  done,
  onFile,
}: {
  label: string;
  done: boolean;
  onFile: (f: File) => void;
}) {
  return (
    <div className="mb-3 rounded-sm border border-dashed border-border p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">
          {label}{" "}
          {done ? <span className="text-xs font-normal text-emerald-700">✓ uploaded</span> : null}
        </p>
      </div>
      <Input
        type="file"
        accept="image/*,application/pdf"
        className="mt-2"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
        }}
      />
    </div>
  );
}
