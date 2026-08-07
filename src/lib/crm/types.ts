export const ROLES = ["admin", "rep", "broker", "gsm", "credit_manager"] as const;
export type Role = (typeof ROLES)[number];

export const STAGES = [
  { id: "new", label: "New Lead", short: "New", pipeline: "lead" as const },
  { id: "contacted", label: "Contacted", short: "Contacted", pipeline: "lead" as const },
  { id: "paused", label: "Paused", short: "Paused", pipeline: "lead" as const },
  { id: "quote_sent", label: "Quote Sent", short: "Quote", pipeline: "lead" as const },
  {
    id: "lease_accepted",
    label: "Lease Accepted",
    short: "Accepted",
    pipeline: "lead" as const,
  },
  {
    id: "credit_review",
    label: "Credit Underwriting",
    short: "Credit",
    pipeline: "credit" as const,
  },
  {
    id: "ready_bc",
    label: "Compliance",
    short: "Compliance",
    pipeline: "compliance" as const,
  },
  { id: "won", label: "Closed Won", short: "Won", pipeline: "compliance" as const },
  { id: "lost", label: "Closed Lost", short: "Lost", pipeline: "lead" as const },
] as const;

export type StageId = (typeof STAGES)[number]["id"];

export const LEAD_TABS = [
  { id: "lead", label: "Lead", description: "Early stage · contact, quotes, activity" },
  { id: "credit", label: "Credit", description: "Underwriting · docs & checklists" },
  { id: "approval", label: "Approval", description: "GSM / Admin recap & decision" },
  { id: "compliance", label: "Compliance", description: "Post-approval funding package" },
] as const;

export type LeadTabId = (typeof LEAD_TABS)[number]["id"];

export const PIPELINES = [
  {
    id: "lead",
    label: "Lead pipeline",
    description: "Inquiry → quote → lease acceptance",
  },
  {
    id: "credit",
    label: "Credit pipeline",
    description: "App, IDs, docs → underwriting → GSM",
  },
  {
    id: "compliance",
    label: "Compliance pipeline",
    description: "After approval → funding & registration",
  },
] as const;

export type PipelineId = (typeof PIPELINES)[number]["id"];

export const CREDIT_PIPELINE_COLUMNS = [
  { id: "app_requested", label: "App sent", short: "App" },
  { id: "app_submitted", label: "App received", short: "Received" },
  { id: "ids_uploaded", label: "IDs in", short: "IDs" },
  { id: "credit_requested", label: "In review", short: "Review" },
  { id: "pending_gsm", label: "GSM queue", short: "GSM" },
  { id: "approved", label: "Approved", short: "OK" },
  { id: "declined", label: "Declined", short: "No" },
] as const;

export type CreditPipelineColumnId = (typeof CREDIT_PIPELINE_COLUMNS)[number]["id"];

export const COMPLIANCE_ITEMS: {
  key: string;
  label: string;
  needsUpload?: boolean;
  needsBank?: boolean;
}[] = [
  { key: "signed_lease", label: "Signed lease uploaded", needsUpload: true },
  { key: "void_check", label: "Void check uploaded", needsUpload: true },
  { key: "insurance", label: "Insurance confirmation", needsUpload: true },
  { key: "tracker", label: "Tracker(s): TAG and/or GPS" },
  { key: "dod_received", label: "DOD (amount due on delivery) received" },
  { key: "no_lien", label: "No lien confirmation uploaded", needsUpload: true },
  { key: "vehicle_paid", label: "Vehicle PAID for" },
  { key: "pml_lien", label: "PML lien on lease" },
  { key: "bank_funding", label: "Bank funding requested", needsBank: true },
  {
    key: "reg_title",
    label: "Reg/Title uploaded (PML as owner/lessor)",
    needsUpload: true,
  },
  { key: "reg_title_cibc", label: "Reg/Title sent to CIBC" },
  { key: "second_key", label: "2nd key requested / received" },
];

export const FUNDING_BANKS = ["RBC", "BMO", "CIBC"] as const;

export function stagesForPipeline(pipeline: PipelineId) {
  return STAGES.filter((s) => s.pipeline === pipeline);
}

export function pipelineForStage(stage: string): PipelineId {
  const found = STAGES.find((s) => s.id === stage);
  return found?.pipeline ?? "lead";
}

export function defaultLeadTab(lead: {
  stage?: string | null;
  credit_status?: string | null;
}): LeadTabId {
  const stage = (lead.stage || "new").toLowerCase();
  const cs = (lead.credit_status || "none").toLowerCase();
  if (stage === "won" || stage === "ready_bc" || cs === "approved") return "compliance";
  if (cs === "pending_gsm") return "approval";
  if (cs === "declined") return "credit";
  if (
    stage === "credit_review" ||
    [
      "app_requested",
      "app_submitted",
      "app_in_progress",
      "ids_uploaded",
      "credit_requested",
      "in_review",
    ].includes(cs)
  ) {
    return "credit";
  }
  return "lead";
}

export function creditColumnForLead(lead: {
  credit_status?: string | null;
  stage?: string | null;
}): CreditPipelineColumnId | null {
  const cs = (lead.credit_status || "none").toLowerCase();
  if (cs === "in_review") return "credit_requested";
  if (CREDIT_PIPELINE_COLUMNS.some((c) => c.id === cs)) {
    return cs as CreditPipelineColumnId;
  }
  if (lead.stage === "credit_review" && (cs === "none" || !cs)) return "app_requested";
  return null;
}

export type ComplianceChecklistItem = {
  id: string;
  lead_id: string;
  item_key: string;
  label: string;
  sort_order: number;
  done: boolean;
  notes: string;
  meta: string;
  file_name: string | null;
  mime_type: string | null;
  has_file: boolean;
  filled_by: string | null;
  filled_at: string | null;
  updated_at: string;
};

export const LEAD_TYPES = [
  {
    id: "inventory",
    label: "Inventory",
    short: "Inventory",
    description: "Inquiry on a car we have for sale (CarGurus, AutoTrader, walk-in)",
  },
  {
    id: "lease",
    label: "Lease",
    short: "Lease",
    description: "Lease quote — broker, dealer, or TAdvantage financing forms",
  },
  {
    id: "general",
    label: "General Interest",
    short: "General",
    description: "General contact / web inquiry (TAdvantage Contact Us, etc.)",
  },
] as const;

export type LeadType = (typeof LEAD_TYPES)[number]["id"];

export const SOURCES = [
  { id: "phone", label: "Phone" },
  { id: "walk_in", label: "Walk-in" },
  { id: "email", label: "Email" },
  { id: "broker", label: "Broker" },
  { id: "other", label: "Other" },
  { id: "web", label: "Web" },
] as const;

export type SourceId = (typeof SOURCES)[number]["id"];

export const REVIEW_STATUSES = [
  { id: "not_requested", label: "Not requested" },
  { id: "requested", label: "Requested" },
  { id: "received", label: "Received" },
] as const;

export type ReviewStatus = (typeof REVIEW_STATUSES)[number]["id"];

export const DRIVE_STATUSES = [
  { id: "scheduled", label: "Scheduled" },
  { id: "completed", label: "Completed" },
  { id: "no_show", label: "No-show" },
  { id: "cancelled", label: "Cancelled" },
] as const;

export type DriveStatus = (typeof DRIVE_STATUSES)[number]["id"];

export type Profile = {
  id: string;
  user_id: string | null;
  email: string;
  name: string;
  role: Role;
  active: boolean;
  phone: string | null;
  title: string | null;
  created_at: string;
  updated_at: string;
};

export type InventoryItem = {
  id: string;
  year: number;
  make: string;
  model: string;
  trim: string | null;
  vin: string | null;
  stock_number: string | null;
  price: number | null;
  mileage: number | null;
  exterior_color: string | null;
  interior_color: string | null;
  body_type: string | null;
  transmission: string | null;
  fuel_type: string | null;
  status: string;
  source: string;
  external_url: string | null;
  image_url: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export type PartyType = "individual" | "business";

export type CreditStatus =
  | "none"
  | "app_requested"
  | "app_submitted"
  | "ids_uploaded"
  | "credit_requested"
  | "in_review"
  | "pending_gsm"
  | "approved"
  | "declined";

export type Lead = {
  id: string;
  name: string;
  first_name?: string | null;
  last_name?: string | null;
  party_type?: PartyType | null;
  phone: string | null;
  email: string | null;
  source: string;
  lead_type: LeadType;
  credit_status?: CreditStatus | string | null;
  credit_app_id?: string | null;
  notes: string | null;
  vehicle_interest: string | null;
  inventory_id: string | null;
  assigned_to: string | null;
  stage: StageId;
  stage_entered_at: string;
  quote_sent: boolean;
  quote_sent_at: string | null;
  quote_link: string | null;
  quote_notes: string | null;
  quote_pdf_name: string | null;
  quote_pdf_data: string | null;
  guarantor?: string | null;
  legal_entity_name?: string | null;
  drive_folder_id?: string | null;
  drive_folder_url?: string | null;
  accepted_quote_id?: string | null;
  source_email_raw: string | null;

  email_portal?: string | null;
  gmail_message_id?: string | null;
  pause_until?: string | null;
  pause_note?: string | null;
  stage_before_pause?: string | null;
  google_review_status: ReviewStatus;
  google_review_at: string | null;
  google_review_link: string | null;
  estimated_value: number | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  assigned_name?: string | null;
  inventory_label?: string | null;
};

export type LeadActivity = {
  id: string;
  lead_id: string;
  kind: string;
  body: string;
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
};

export type TestDrive = {
  id: string;
  lead_id: string;
  inventory_id: string | null;
  scheduled_at: string;
  duration_minutes: number;
  status: DriveStatus;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  lead_name?: string | null;
  vehicle_label?: string | null;
};

export type LeadAppointment = {
  id: string;
  lead_id: string;
  profile_id: string | null;
  scheduled_at: string;
  kind: string;
  note: string | null;
  status: string;
  created_by: string | null;
  created_at: string;
};

export type AdminMetrics = {
  overall: {
    total: number;
    won: number;
    lost: number;
    success_rate: number;
    contact_rate: number;
    review_rate: number;
    pipeline_value: number;
  };
  by_rep: Array<{
    profile_id: string;
    name: string;
    role: string;
    total: number;
    won: number;
    success_rate: number;
    contact_rate: number;
    review_rate: number;
    reviews_received: number;
  }>;
  funnel: Array<{ stage: string; count: number }>;
};

export type PortalCloseStats = {
  portal: string;
  label: string;
  total: number;
  won: number;
  lost: number;
  open: number;
  close_rate: number;
};

export type RepCloseStats = {
  profile_id: string;
  name: string;
  role: string;
  inventory_total: number;
  inventory_won: number;
  inventory_close_rate: number;
  all_total: number;
  all_won: number;
  all_close_rate: number;
};

export type DataAnalysis = {
  portal_inventory: PortalCloseStats[];
  by_rep: RepCloseStats[];
  generated_at: string;
};

export type ParsedEmailLead = {
  lead_type: LeadType;
  name: string;
  phone: string;
  email: string;
  vehicle_interest: string;
  stock_number: string;
  notes: string;
  source: SourceId;
  confidence: "high" | "medium" | "low";
  matched_fields: string[];
};

export function isStageId(v: string): v is StageId {
  return STAGES.some((s) => s.id === v);
}

export function isLeadType(v: string): v is LeadType {
  return LEAD_TYPES.some((t) => t.id === v);
}

export function stageLabel(id: string) {
  return STAGES.find((s) => s.id === id)?.label ?? id;
}

export function sourceLabel(id: string) {
  return SOURCES.find((s) => s.id === id)?.label ?? id;
}

export function reviewLabel(id: string) {
  return REVIEW_STATUSES.find((s) => s.id === id)?.label ?? id;
}

export function leadTypeLabel(id: string) {
  return LEAD_TYPES.find((t) => t.id === id)?.label ?? id;
}

export function vehicleLabel(item: Pick<InventoryItem, "year" | "make" | "model" | "trim">) {
  return [item.year, item.make, item.model, item.trim].filter(Boolean).join(" ");
}

export function daysInStage(stageEnteredAt: string) {
  const d = new Date(stageEnteredAt);
  if (Number.isNaN(d.getTime())) return 0;
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / 86400000));
}

export const ROLE_LABELS: Record<Role, string> = {
  admin: "Admin",
  rep: "Sales Rep",
  broker: "Broker",
  gsm: "General Sales Manager",
  credit_manager: "Credit Manager",
};

export type CreditAppStatus =
  | "draft"
  | "app_requested"
  | "app_in_progress"
  | "app_submitted"
  | "ids_uploaded"
  | "credit_requested"
  | "in_review"
  | "pending_gsm"
  | "approved"
  | "declined"
  | "cancelled";

/** Free-form document kind (IDs, lessee requests, checklist uploads). */
export type CreditDocumentKind = string;

/** Serializable form answers (string values only — createServerFn requirement). */
export type CreditPayload = Record<string, string>;

export type CreditApplication = {
  id: string;
  lead_id: string;
  status: CreditAppStatus;
  party_type: PartyType;
  payload: CreditPayload;
  public_token: string | null;
  doc_request_token: string | null;
  app_email: string | null;
  requested_by: string | null;
  submitted_at: string | null;
  credit_requested_at: string | null;
  credit_requested_by: string | null;
  credit_request_notes: string | null;
  do_not_pull_credit: boolean;
  equifax_file_name: string | null;
  equifax_file_data: string | null;
  equifax_notes: string | null;
  gsm_requested_at: string | null;
  gsm_requested_by: string | null;
  approved_by: string | null;
  approved_at: string | null;
  approval_notes: string | null;
  vehicle_checklist_complete: boolean;
  customer_checklist_complete: boolean;
  created_at: string;
  updated_at: string;
};

export type CreditDocument = {
  id: string;
  application_id: string;
  lead_id: string;
  kind: CreditDocumentKind;
  file_name: string;
  mime_type: string;
  file_data: string;
  uploaded_by: string | null;
  uploaded_via: string;
  created_at: string;
};

export type CreditChecklistItem = {
  id: string;
  application_id: string;
  section: "vehicle" | "customer";
  item_key: string;
  label: string;
  notes: string;
  done: boolean;
  filled_by: string | null;
  filled_at: string | null;
};

export type ChecklistDef = {
  key: string;
  label: string;
  /** Staff can attach a supporting file on this line. */
  needsUpload?: boolean;
  /** Upload is required before marking done (signoff). */
  uploadRequired?: boolean;
  /** Not required for section complete / Request GSM. */
  optionalForComplete?: boolean;
};

export const VEHICLE_CHECKLIST: ChecklistDef[] = [
  {
    key: "listing_pics",
    label: "Listing & Pictures of Vehicle",
    needsUpload: true,
    uploadRequired: true,
  },
  { key: "price_justified", label: "Selling price of the vehicle is justified" },
  { key: "vehicle_specs", label: "Understanding of the vehicle specs" },
  { key: "market_benchmark", label: "Market benchmark and future value assessed" },
  {
    key: "carfax_lien",
    label: "Carfax verified",
    needsUpload: true,
    uploadRequired: true,
  },
  { key: "keys_verified", label: "Number of keys verified; second key will be sent" },
  {
    key: "bill_of_sale",
    label: "Bill of Sale",
    needsUpload: true,
    optionalForComplete: true,
  },
];

export const CUSTOMER_CHECKLIST: ChecklistDef[] = [
  { key: "ids_verified", label: "IDs received and verified", needsUpload: true },
  {
    key: "status_visa",
    label: "Customer has permanent status or VISA provided",
    needsUpload: true,
  },
  { key: "equifax", label: "Equifax was pulled and verified", needsUpload: true },
  {
    key: "phone_interview",
    label: "Phone interview to verify customer information",
  },
  {
    key: "address_ownership",
    label: "Address was verified and ownership checked",
    needsUpload: true,
  },
  {
    key: "noa_payslips",
    label: "NOAs/payslips verified (optional)",
    needsUpload: true,
  },
  {
    key: "bank_statements",
    label: "Bank/Financial statements verified (optional)",
    needsUpload: true,
  },
  {
    key: "kyc",
    label: "KYC on the customer (Google, social, CanLII, etc.)",
    needsUpload: true,
  },
  {
    key: "money_flow",
    label: "Understanding of how the customer makes and spends money",
  },
];

/** Docs the Credit Manager can request from the lessee (generic request dialog). */
export const LESSEE_DOC_TYPES = [
  { key: "personal_bank_statements", label: "Personal bank statements" },
  { key: "business_bank_statements", label: "Business bank statements" },
  { key: "noas", label: "NOAs" },
  { key: "tax_bill", label: "Tax bill" },
  { key: "t4", label: "T4" },
  { key: "mortgage_statement", label: "Mortgage statement" },
  { key: "school_letter", label: "School Letter" },
  { key: "visa_status", label: "VISA (student/work)" },
  { key: "enrollment_letter", label: "Enrollment letter" },
] as const;

export type LesseeDocTypeKey = (typeof LESSEE_DOC_TYPES)[number]["key"];

export function checklistDef(section: "vehicle" | "customer", key: string): ChecklistDef | undefined {
  const list = section === "vehicle" ? VEHICLE_CHECKLIST : CUSTOMER_CHECKLIST;
  return list.find((i) => i.key === key);
}

export function lesseeDocLabel(key: string) {
  return LESSEE_DOC_TYPES.find((d) => d.key === key)?.label ?? key.replace(/_/g, " ");
}

/** Team calendar event types (domain derived). */
export const CALENDAR_EVENT_TYPES = [
  { id: "test_drive", label: "Test drive", domain: "sales" as const },
  { id: "vehicle_viewing", label: "Vehicle viewing", domain: "sales" as const },
  { id: "delivery", label: "Vehicle delivery", domain: "sales" as const },
  { id: "antitheft_install", label: "Anti-theft installation", domain: "compliance" as const },
  { id: "repair", label: "Repair appointment", domain: "service" as const },
  { id: "detailing", label: "Car detailing", domain: "service" as const },
  { id: "other", label: "Other", domain: "sales" as const },
] as const;

export type CalendarEventTypeId = (typeof CALENDAR_EVENT_TYPES)[number]["id"];
export type CalendarDomain = "sales" | "compliance" | "service";

export const CALENDAR_DOMAINS: { id: CalendarDomain; label: string }[] = [
  { id: "sales", label: "Sales" },
  { id: "compliance", label: "Compliance" },
  { id: "service", label: "Service" },
];

export type CalendarScope = "mine" | "organize" | "invited" | "team";

export type CalendarEvent = {
  id: string;
  title: string;
  event_type: CalendarEventTypeId | string;
  domain: CalendarDomain | string;
  starts_at: string;
  ends_at: string;
  all_day: boolean;
  location: string | null;
  notes: string | null;
  lead_id: string | null;
  inventory_id: string | null;
  organizer_id: string;
  organizer_name?: string | null;
  visibility: "team" | "private";
  status: "scheduled" | "completed" | "cancelled" | "no_show" | string;
  created_at: string;
  updated_at: string;
  participant_ids: string[];
  participant_names?: string[];
  lead_name?: string | null;
};

export function calendarTypeMeta(typeId: string) {
  return (
    CALENDAR_EVENT_TYPES.find((t) => t.id === typeId) || {
      id: typeId,
      label: typeId.replace(/_/g, " "),
      domain: "sales" as const,
    }
  );
}

export function domainForEventType(typeId: string): CalendarDomain {
  return calendarTypeMeta(typeId).domain;
}

export const TASK_TYPES = [
  { id: "call", label: "Phone call" },
  { id: "email", label: "Email" },
  { id: "follow_up", label: "Follow-up" },
  { id: "other", label: "Other" },
] as const;

export type TaskTypeId = (typeof TASK_TYPES)[number]["id"];

export type CrmTask = {
  id: string;
  title: string;
  task_type: TaskTypeId | string;
  due_at: string | null;
  due_date: string | null;
  owner_id: string;
  owner_name?: string | null;
  lead_id: string | null;
  lead_name?: string | null;
  notes: string | null;
  status: "open" | "done" | string;
  completed_at: string | null;
  completed_by: string | null;
  created_at: string;
  updated_at: string;
};

export type TaskListView = "today" | "overdue" | "upcoming" | "completed";
