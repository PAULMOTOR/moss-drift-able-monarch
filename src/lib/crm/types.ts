export const ROLES = ["admin", "rep", "broker", "gsm", "credit_manager"] as const;
export type Role = (typeof ROLES)[number];

export const STAGES = [
  { id: "new", label: "New Lead", short: "New" },
  { id: "contacted", label: "Contacted", short: "Contacted" },
  { id: "paused", label: "Paused", short: "Paused" },
  { id: "quote_sent", label: "Quote Sent", short: "Quote" },
  { id: "credit_review", label: "Credit Underwriting", short: "Credit" },
  { id: "ready_bc", label: "Ready for Business Central", short: "BC Ready" },
  { id: "won", label: "Closed Won", short: "Won" },
  { id: "lost", label: "Closed Lost", short: "Lost" },
] as const;


export type StageId = (typeof STAGES)[number]["id"];

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

export type CreditDocumentKind =
  | "dl_front"
  | "dl_back"
  | "id_second"
  | "noa_payslip"
  | "bank_statement"
  | "equifax"
  | "other";

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

export const VEHICLE_CHECKLIST: { key: string; label: string }[] = [
  { key: "listing_pics", label: "Listing or pictures of the vehicle" },
  { key: "price_justified", label: "Selling price of the vehicle is justified" },
  { key: "vehicle_specs", label: "Understanding of the vehicle specs" },
  { key: "market_benchmark", label: "Market benchmark and future value assessed" },
  { key: "carfax_lien", label: "Carfax and lien check verified" },
  { key: "keys_verified", label: "Number of keys verified; second key will be sent" },
];

export const CUSTOMER_CHECKLIST: { key: string; label: string }[] = [
  { key: "ids_verified", label: "IDs received and verified" },
  { key: "status_visa", label: "Customer has permanent status or VISA provided" },
  { key: "equifax", label: "Equifax was pulled and verified" },
  { key: "phone_interview", label: "Phone interview to verify customer information" },
  { key: "address_ownership", label: "Address was verified and ownership checked" },
  { key: "noa_payslips", label: "NOAs/payslips verified (optional)" },
  { key: "bank_statements", label: "Bank/Financial statements verified (optional)" },
  { key: "kyc", label: "KYC on the customer (Google, social, CanLII, etc.)" },
  { key: "money_flow", label: "Understanding of how the customer makes and spends money" },
];
