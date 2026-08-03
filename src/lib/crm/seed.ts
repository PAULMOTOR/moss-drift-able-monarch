import { hashPassword } from "better-auth/crypto";
import type { Sql } from "@/lib/db";
import { DEMO_PASSWORD, shouldSeedDemoData } from "./demo";
import { REAL_INVENTORY } from "./real-inventory";

export { DEMO_PASSWORD };

const STAFF = [
  {
    id: "prof-jeremy",
    userId: "user-jeremy",
    email: "jeremyp@paulmotorcompany.com",
    name: "Jeremy Paul",
    role: "admin" as const,
    title: "President",
    phone: "514-767-0101",
  },
  {
    id: "prof-guillaume",
    userId: "user-guillaume",
    email: "guillaume.dec@paulmotorcompany.com",
    name: "Guillaume Decroocq",
    role: "admin" as const,
    title: "VP",
    phone: "514-767-0102",
  },
  {
    id: "prof-lucas",
    userId: "user-lucas",
    email: "lucasl@paulmotorcompany.com",
    name: "Lucas Legatos",
    role: "rep" as const,
    title: "Sales Representative",
    phone: "514-767-0103",
  },
  {
    id: "prof-alex",
    userId: "user-alex",
    email: "alexh@paulmotorcompany.com",
    name: "Alex Hudon",
    role: "rep" as const,
    title: "Sales Representative",
    phone: "514-767-0104",
  },
  {
    id: "prof-broker-marie",
    userId: "user-broker-marie",
    email: "marie@exoticroutes.ca",
    name: "Marie Lefebvre",
    role: "broker" as const,
    title: "External Broker",
    phone: "514-555-0188",
  },
  {
    id: "prof-broker-sam",
    userId: "user-broker-sam",
    email: "sam@eliteauto.ca",
    name: "Sam Khouri",
    role: "broker" as const,
    title: "External Broker",
    phone: "438-555-0199",
  },
];

function uid() {
  return crypto.randomUUID();
}

function daysAgo(n: number) {
  return new Date(Date.now() - n * 86400000).toISOString();
}

type StaffSeed = (typeof STAFF)[number];

async function insertStaffMember(
  sql: Sql,
  s: StaffSeed,
  passwordHash: string,
  now: string,
  mode: "insert" | "ensure",
) {
  if (mode === "ensure") {
    const existing = await sql<{ id: string }>`select id from profiles where id = ${s.id} limit 1`;
    if (existing[0]) {
      const prof = await sql<{ user_id: string | null; email: string; name: string }>`
        select user_id, email, name from profiles where id = ${s.id}
      `;
      const p = prof[0]!;
      const userId = p.user_id || s.userId;
      const userRow = await sql`select id from "user" where id = ${userId} limit 1`;
      if (!userRow[0]) {
        await sql`
          insert into "user" (id, name, email, "emailVerified", image, "createdAt", "updatedAt")
          values (${userId}, ${p.name}, ${p.email}, true, null, ${now}, ${now})
          on conflict (id) do nothing
        `;
        await sql`update profiles set user_id = ${userId} where id = ${s.id}`;
      }
      const acc = await sql`
        select id from account where "userId" = ${userId} and "providerId" = 'credential' limit 1
      `;
      if (!acc[0]) {
        await sql`
          insert into account (
            id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt"
          ) values (
            ${`acc-${userId}`}, ${p.email}, 'credential', ${userId},
            ${passwordHash}, ${now}, ${now}
          )
          on conflict (id) do nothing
        `;
      }
      return;
    }
  }

  const emailTaken = await sql`select id from profiles where email = ${s.email} limit 1`;
  if (emailTaken[0] && emailTaken[0].id !== s.id) return;

  await sql`
    insert into "user" (id, name, email, "emailVerified", image, "createdAt", "updatedAt")
    values (${s.userId}, ${s.name}, ${s.email}, true, null, ${now}, ${now})
    on conflict (id) do update set
      name = excluded.name,
      email = excluded.email,
      "updatedAt" = excluded."updatedAt"
  `;
  await sql`
    update "user" set email = ${s.email}, name = ${s.name}, "updatedAt" = ${now}
    where id = ${s.userId}
  `;

  const acc = await sql<{ id: string }>`
    select id from account where "userId" = ${s.userId} and "providerId" = 'credential' limit 1
  `;
  if (acc[0]) {
    await sql`
      update account set
        "accountId" = ${s.email},
        password = ${passwordHash},
        "updatedAt" = ${now}
      where id = ${acc[0].id}
    `;
  } else {
    await sql`
      insert into account (
        id, "accountId", "providerId", "userId", "accessToken", "refreshToken",
        "idToken", "accessTokenExpiresAt", "refreshTokenExpiresAt", scope, password,
        "createdAt", "updatedAt"
      ) values (
        ${`acc-${s.userId}`}, ${s.email}, 'credential', ${s.userId},
        null, null, null, null, null, null, ${passwordHash}, ${now}, ${now}
      )
      on conflict (id) do update set
        "accountId" = excluded."accountId",
        password = excluded.password,
        "updatedAt" = excluded."updatedAt"
    `;
  }

  await sql`
    insert into profiles (id, user_id, email, name, role, active, phone, title)
    values (
      ${s.id}, ${s.userId}, ${s.email}, ${s.name}, ${s.role}, true,
      ${s.phone}, ${s.title}
    )
    on conflict (id) do nothing
  `;
}

async function syncStaff(sql: Sql) {
  const passwordHash = await hashPassword(DEMO_PASSWORD);
  const now = new Date().toISOString();
  const count = await sql<{ n: number }>`select count(*)::int as n from profiles`;
  const empty = (count[0]?.n ?? 0) === 0;

  if (empty) {
    for (const s of STAFF) {
      await insertStaffMember(sql, s, passwordHash, now, "insert");
    }
    return;
  }

  for (const s of STAFF) {
    if (s.role === "admin") {
      await insertStaffMember(sql, s, passwordHash, now, "ensure");
    } else {
      const exists = await sql`select id from profiles where id = ${s.id} limit 1`;
      if (exists[0]) {
        await insertStaffMember(sql, s, passwordHash, now, "ensure");
      }
    }
  }
}

/**
 * Replace website/autotrader-sourced stock with the live Paul Motor list.
 * Source: paulmotorleasing.com used inventory (real stock numbers).
 * Keeps rows with source = "manual".
 */
export async function syncRealInventory(sql: Sql): Promise<number> {
  const realStocks = REAL_INVENTORY.map((v) => v.stock_number);
  const existing = await sql<{
    id: string;
    stock_number: string | null;
    source: string;
    year: number;
    make: string;
    model: string;
  }>`
    select id, stock_number, source, year, make, model from inventory
  `;

  for (const row of existing) {
    const isReal = row.stock_number && realStocks.includes(row.stock_number);
    const isAutoOrSite =
      row.source === "website" ||
      row.source === "autotrader" ||
      row.source === "paulmotor" ||
      (row.stock_number || "").startsWith("AT-");
    if (!isReal && isAutoOrSite) {
      await sql`update leads set inventory_id = null where inventory_id = ${row.id}`;
      await sql`update test_drives set inventory_id = null where inventory_id = ${row.id}`;
      await sql`delete from inventory where id = ${row.id}`;
    }
  }

  let count = 0;
  for (const v of REAL_INVENTORY) {
    const found = await sql<{ id: string }>`
      select id from inventory where stock_number = ${v.stock_number} limit 1
    `;
    // Also rematch by year+make+model if an old AT-* or wrong stock still matches the car
    let rowId = found[0]?.id;
    if (!rowId) {
      const byYm = await sql<{ id: string }>`
        select id from inventory
        where year = ${v.year}
          and lower(make) = ${v.make.toLowerCase()}
          and lower(model) = ${v.model.toLowerCase()}
          and source in ('website', 'autotrader', 'paulmotor')
        limit 1
      `;
      rowId = byYm[0]?.id;
    }

    const note =
      v.notes ??
      "Paul Motor Leasing website · https://www.paulmotorleasing.com/vehicles/used/";
    const vin = v.vin ?? null;
    const color = v.exterior_color ?? null;

    if (rowId) {
      await sql`
        update inventory set
          year = ${v.year},
          make = ${v.make},
          model = ${v.model},
          trim = ${v.trim},
          stock_number = ${v.stock_number},
          vin = coalesce(${vin}, vin),
          price = ${v.price},
          mileage = ${v.mileage},
          body_type = ${v.body_type},
          exterior_color = coalesce(${color}, exterior_color),
          status = 'available',
          source = 'website',
          external_url = ${v.external_url},
          notes = ${note},
          updated_at = now()
        where id = ${rowId}
      `;
    } else {
      await sql`
        insert into inventory (
          id, year, make, model, trim, stock_number, vin, price, mileage,
          body_type, exterior_color, status, source, external_url, notes
        ) values (
          ${uid()}, ${v.year}, ${v.make}, ${v.model}, ${v.trim}, ${v.stock_number},
          ${vin}, ${v.price}, ${v.mileage}, ${v.body_type}, ${color},
          'available', 'website', ${v.external_url}, ${note}
        )
      `;
    }
    count += 1;
  }
  return count;
}

export async function ensureCrmSeeded(sql: Sql) {
  const profileCount = await sql<{ n: number }>`select count(*)::int as n from profiles`;
  const profilesEmpty = (profileCount[0]?.n ?? 0) === 0;
  const seed = shouldSeedDemoData({ profilesEmpty });

  if (!seed) {
    // Always refresh website inventory so stock numbers stay current
    await syncRealInventory(sql);
    return;
  }

  await syncStaff(sql);
  await syncRealInventory(sql);

  const leadCount = await sql<{ n: number }>`select count(*)::int as n from leads`;
  if ((leadCount[0]?.n ?? 0) > 0) return;

  const invRows = await sql<{ id: string; stock_number: string | null; price: number | null }>`
    select id, stock_number, price::float8 as price from inventory order by price desc nulls last
  `;
  const byStock = new Map(invRows.map((r) => [r.stock_number, r]));

  type SeedLead = {
    name: string;
    phone?: string;
    email?: string;
    source: string;
    lead_type: "inventory" | "lease";
    stage: string;
    assigned: string;
    interest: string;
    stock?: string;
    quote?: boolean;
    review?: string;
    notes?: string;
    days: number;
    value?: number;
  };

  const leads: SeedLead[] = [
    {
      name: "Philippe Moreau",
      phone: "514-555-2201",
      email: "p.moreau@example.com",
      source: "walk_in",
      lead_type: "inventory",
      stage: "new",
      assigned: "prof-lucas",
      interest: "2024 Ferrari Purosangue AWD",
      stock: "18160",
      days: 0,
      notes: "Walk-in Saturday — wants weekend demo on the Purosangue",
    },
    {
      name: "Nadia Chen",
      phone: "438-555-2210",
      email: "nadia.chen@corp.ca",
      source: "broker",
      lead_type: "lease",
      stage: "contacted",
      assigned: "prof-alex",
      interest: "2025 Porsche 911 Carrera S — 36/10k lease",
      days: 1,
      notes: "Outside broker lease quote request",
      value: 185000,
    },
    {
      name: "Olivier Tremblay",
      phone: "450-555-2233",
      email: "olivier.t@gmail.com",
      source: "email",
      lead_type: "inventory",
      stage: "test_drive",
      assigned: "prof-lucas",
      interest: "2025 Porsche Taycan Turbo GT Weissach",
      stock: "TAY-GT-25",
      days: 2,
    },
    {
      name: "Sophia Bernstein",
      phone: "514-555-2244",
      email: "sophia.b@bernsteinlaw.ca",
      source: "broker",
      lead_type: "lease",
      stage: "quote_sent",
      assigned: "prof-broker-marie",
      interest: "2024 Mercedes-AMG G63 — 48 month lease",
      quote: true,
      days: 4,
      value: 280000,
    },
    {
      name: "Karim Hassan",
      phone: "514-555-2255",
      email: "karim@hassan.dev",
      source: "phone",
      lead_type: "inventory",
      stage: "ready_bc",
      assigned: "prof-alex",
      interest: "2019 McLaren 600LT",
      stock: "14067",
      quote: true,
      days: 6,
      review: "requested",
    },
    {
      name: "Émilie Roy",
      phone: "438-555-2266",
      email: "emilie.roy@icloud.com",
      source: "walk_in",
      lead_type: "inventory",
      stage: "won",
      assigned: "prof-lucas",
      interest: "2023 Audi R8 Coupe Performance",
      stock: "R8-23",
      quote: true,
      days: 14,
      review: "received",
    },
    {
      name: "James Whitfield",
      phone: "514-555-2277",
      email: "jwhit@outlook.com",
      source: "email",
      lead_type: "inventory",
      stage: "lost",
      assigned: "prof-alex",
      interest: "2015 Ferrari 458 Speciale",
      stock: "19064",
      days: 20,
      notes: "Bought out of province",
    },
    {
      name: "Camille Duval",
      phone: "514-555-2288",
      source: "broker",
      lead_type: "lease",
      stage: "new",
      assigned: "prof-broker-sam",
      interest: "2025 Range Rover Sport P530 — lease quote",
      days: 0,
      value: 165000,
    },
    {
      name: "Robert Gagnon",
      phone: "450-555-2299",
      email: "r.gagnon@nordic.ca",
      source: "broker",
      lead_type: "lease",
      stage: "contacted",
      assigned: "prof-broker-marie",
      interest: "Two SUVs — Urus + Bentayga lease structures",
      days: 3,
      value: 420000,
    },
    {
      name: "Aisha Patel",
      phone: "514-555-2300",
      email: "aisha.patel@gmail.com",
      source: "walk_in",
      lead_type: "inventory",
      stage: "test_drive",
      assigned: "prof-lucas",
      interest: "2021 Porsche 718 Cayman GT4",
      stock: "18022",
      days: 1,
    },
    {
      name: "Marc Lefebvre",
      phone: "514-555-2311",
      email: "marc@lefebvre-const.ca",
      source: "phone",
      lead_type: "inventory",
      stage: "quote_sent",
      assigned: "prof-alex",
      interest: "2018 Mercedes G 550 4x4²",
      stock: "16111",
      quote: true,
      days: 5,
    },
    {
      name: "Hélène Bouchard",
      phone: "438-555-2322",
      email: "helene.b@med.ca",
      source: "email",
      lead_type: "inventory",
      stage: "contacted",
      assigned: "prof-lucas",
      interest: "2019 Aston Martin Vantage",
      stock: "SCFSMGAW5KGN00739",
      days: 2,
    },
    {
      name: "Daniel Cho",
      phone: "514-555-2333",
      email: "dcho@startup.io",
      source: "web",
      lead_type: "inventory",
      stage: "new",
      assigned: "prof-alex",
      interest: "2001 BMW Z8",
      stock: "18165",
      days: 0,
    },
    {
      name: "Isabelle Morin",
      phone: "450-555-2344",
      email: "isabelle.morin@gmail.com",
      source: "phone",
      lead_type: "lease",
      stage: "ready_bc",
      assigned: "prof-lucas",
      interest: "2024 Porsche Cayenne Turbo GT lease",
      quote: true,
      days: 8,
      value: 210000,
      review: "requested",
    },
    {
      name: "Vincent Caron",
      phone: "514-555-2355",
      email: "v.caron@qc.ca",
      source: "walk_in",
      lead_type: "inventory",
      stage: "won",
      assigned: "prof-alex",
      interest: "2019 Bentley Bentayga AWD",
      stock: "14172",
      quote: true,
      days: 18,
      review: "received",
    },
  ];

  for (const L of leads) {
    const id = uid();
    const created = daysAgo(L.days);
    const inv = L.stock ? byStock.get(L.stock) : undefined;
    const invId = inv?.id ?? null;
    const value = L.value ?? (inv?.price != null ? Number(inv.price) : null);
    await sql`
      insert into leads (
        id, name, phone, email, source, lead_type, notes, vehicle_interest, inventory_id,
        assigned_to, stage, stage_entered_at, quote_sent, quote_sent_at,
        quote_notes, google_review_status, google_review_at, google_review_link,
        estimated_value, created_by, created_at, updated_at
      ) values (
        ${id}, ${L.name}, ${L.phone ?? null}, ${L.email ?? null}, ${L.source},
        ${L.lead_type}, ${L.notes ?? null}, ${L.interest}, ${invId}, ${L.assigned}, ${L.stage},
        ${created}, ${L.quote === true},
        ${L.quote ? created : null},
        ${L.quote ? "Lease / retail options emailed" : null},
        ${L.review ?? "not_requested"},
        ${L.review === "received" || L.review === "requested" ? created : null},
        ${L.review === "received" ? "https://g.page/r/paul-motor-review" : null},
        ${value}, ${L.assigned}, ${created}, ${created}
      )
    `;
    await sql`
      insert into lead_activities (id, lead_id, kind, body, created_by_name, created_at)
      values (
        ${uid()}, ${id}, 'system',
        ${`Lead captured via ${L.source} · ${L.lead_type}`},
        'System', ${created}
      )
    `;
    if (L.notes) {
      await sql`
        insert into lead_activities (id, lead_id, kind, body, created_by_name, created_at)
        values (${uid()}, ${id}, 'note', ${L.notes}, 'Team', ${created})
      `;
    }
  }

  const leadRows = await sql<{ id: string; inventory_id: string | null; name: string }>`
    select id, inventory_id, name from leads where stage in ('test_drive', 'quote_sent', 'ready_bc') limit 4
  `;
  for (let i = 0; i < leadRows.length; i++) {
    const lead = leadRows[i]!;
    const when = new Date(Date.now() + (i - 1) * 86400000);
    when.setHours(11 + i, 0, 0, 0);
    await sql`
      insert into test_drives (
        id, lead_id, inventory_id, scheduled_at, duration_minutes, status, notes, created_by
      ) values (
        ${uid()}, ${lead.id}, ${lead.inventory_id}, ${when.toISOString()}, 45,
        ${i === 0 ? "completed" : "scheduled"},
        ${`Demo for ${lead.name}`}, 'prof-lucas'
      )
    `;
  }
}
