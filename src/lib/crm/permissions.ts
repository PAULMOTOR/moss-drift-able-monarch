/**
 * Role permission matrix — defaults from types, overrides in role_permissions table.
 */
import { createServerFn } from "@tanstack/react-start";
import { getSql } from "@/lib/db";
import { authMiddleware } from "@/lib/auth/middleware";
import {
  DEFAULT_ROLE_PERMISSIONS,
  PERMISSION_KEYS,
  ROLES,
  type PermissionKey,
  type Profile,
  type Role,
} from "./types";

async function requireProfile(userId: string): Promise<Profile> {
  const sql = await getSql();
  const rows = await sql<Profile>`
    select id, user_id, email, name, role, active, phone, title,
           avatar_url, created_at::text as created_at, updated_at::text as updated_at
    from profiles where user_id = ${userId} limit 1
  `;
  if (!rows[0]?.active) throw new Error("No active CRM profile");
  return rows[0];
}

/** Resolve allowed permission keys for a role (defaults + DB overrides). */
export async function permissionsForRole(role: Role): Promise<Set<PermissionKey>> {
  const defaults = new Set<PermissionKey>(DEFAULT_ROLE_PERMISSIONS[role] || []);
  try {
    const sql = await getSql();
    const rows = await sql<{ permission_key: string; allowed: boolean }>`
      select permission_key, allowed from role_permissions where role = ${role}
    `;
    for (const r of rows) {
      const key = r.permission_key as PermissionKey;
      if (r.allowed) defaults.add(key);
      else defaults.delete(key);
    }
  } catch {
    // table may not exist yet during first boot
  }
  // Admin always has everything
  if (role === "admin") {
    return new Set(PERMISSION_KEYS.map((p) => p.key));
  }
  return defaults;
}

export function hasPerm(set: Set<PermissionKey>, key: PermissionKey): boolean {
  return set.has(key);
}

export async function profileHasPermission(
  me: Profile,
  key: PermissionKey,
): Promise<boolean> {
  if (me.role === "admin") return true;
  const set = await permissionsForRole(me.role);
  return set.has(key);
}

export const getMyPermissions = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const me = await requireProfile(context.userId);
    const set = await permissionsForRole(me.role);
    return {
      me,
      permissions: [...set],
    };
  });

export const getRolePermissionMatrix = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const me = await requireProfile(context.userId);
    if (me.role !== "admin") throw new Error("Admin access required");
    const sql = await getSql();
    const overrides = await sql<{ role: string; permission_key: string; allowed: boolean }>`
      select role, permission_key, allowed from role_permissions
    `;
    const overrideMap = new Map(
      overrides.map((o) => [`${o.role}:${o.permission_key}`, o.allowed]),
    );
    const matrix: Record<string, Record<string, boolean>> = {};
    for (const role of ROLES) {
      matrix[role] = {};
      const defaults = new Set(DEFAULT_ROLE_PERMISSIONS[role] || []);
      for (const p of PERMISSION_KEYS) {
        const k = `${role}:${p.key}`;
        if (overrideMap.has(k)) {
          matrix[role][p.key] = overrideMap.get(k)!;
        } else {
          matrix[role][p.key] = role === "admin" ? true : defaults.has(p.key);
        }
      }
    }
    return { keys: PERMISSION_KEYS, roles: ROLES, matrix };
  });

export const setRolePermission = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    (data: { role: Role; permission_key: PermissionKey; allowed: boolean }) => data,
  )
  .handler(async ({ context, data }) => {
    const me = await requireProfile(context.userId);
    if (me.role !== "admin") throw new Error("Admin access required");
    if (data.role === "admin") {
      throw new Error("Admin permissions cannot be reduced");
    }
    const sql = await getSql();
    await sql`
      insert into role_permissions (role, permission_key, allowed, updated_at, updated_by)
      values (${data.role}, ${data.permission_key}, ${data.allowed}, now(), ${me.id})
      on conflict (role, permission_key) do update set
        allowed = excluded.allowed,
        updated_at = now(),
        updated_by = excluded.updated_by
    `;
    return { ok: true as const };
  });
