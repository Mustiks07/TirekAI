import { AppError } from "./errors";
import type { Role } from "./contracts";
export type Permission =
  | "organization:read"
  | "organization:write"
  | "team:read"
  | "team:write"
  | "audit:read"
  | "customers:read"
  | "customers:write"
  | "imports:write"
  | "catalog:read"
  | "catalog:write"
  | "inventory:read"
  | "inventory:write"
  | "inventory:sell"
  | "inventory:cost"
  | "orders:read"
  | "orders:write"
  | "finance:read"
  | "finance:write"
  | "purchasing:read"
  | "purchasing:write"
  | "purchasing:approve"
  | "tasks:read"
  | "tasks:write"
  | "tasks:manage"
  | "tasks:verify"
  | "knowledge:read"
  | "knowledge:write"
  | "insights:read"
  | "proposals:write"
  | "automations:read"
  | "automations:write"
  | "assistant:use"
  | "assistant:configure"
  | "integrations:read"
  | "integrations:write";
const grants: Record<Role, readonly Permission[]> = {
  owner: [
    "organization:read",
    "organization:write",
    "team:read",
    "team:write",
    "audit:read",
    "customers:read",
    "customers:write",
    "imports:write",
  ],
  manager: [
    "organization:read",
    "team:read",
    "audit:read",
    "customers:read",
    "customers:write",
    "imports:write",
  ],
  sales: [
    "organization:read",
    "customers:read",
    "customers:write",
    "imports:write",
  ],
  purchasing: ["organization:read"],
  finance: ["organization:read"],
  employee: ["organization:read"],
  observer: ["organization:read"],
};
const all: Role[] = [
  "owner",
  "manager",
  "sales",
  "purchasing",
  "finance",
  "employee",
  "observer",
];
// T021–T030: execution, knowledge, automation, assistant and integration rights.
// Situations and tools additionally require the permission of the underlying data.
const execution: Partial<Record<Permission, readonly Role[]>> = {
  "tasks:read": all,
  "tasks:write": ["owner", "manager", "sales", "purchasing", "finance"],
  "tasks:manage": ["owner", "manager"],
  "tasks:verify": ["owner", "manager"],
  "knowledge:read": all,
  "knowledge:write": ["owner", "manager"],
  "insights:read": ["owner", "manager", "sales", "purchasing", "finance"],
  "proposals:write": ["owner", "manager", "sales", "purchasing", "finance"],
  "automations:read": ["owner", "manager"],
  "automations:write": ["owner", "manager"],
  "assistant:use": all,
  "assistant:configure": ["owner"],
  "integrations:read": ["owner", "manager"],
  "integrations:write": ["owner"],
};
export function can(role: Role, permission: Permission) {
  const scoped = execution[permission];
  if (scoped) return scoped.includes(role);
  if (permission === "purchasing:read")
    return ["owner", "manager", "purchasing", "finance"].includes(role);
  if (permission === "purchasing:write")
    return ["owner", "manager", "purchasing"].includes(role);
  if (permission === "purchasing:approve")
    return ["owner", "manager"].includes(role);
  const commerce: Partial<Record<Role, Permission[]>> = {
    owner: ["orders:read", "orders:write", "finance:read", "finance:write"],
    manager: ["orders:read", "orders:write", "finance:read", "finance:write"],
    sales: ["orders:read", "orders:write"],
    finance: ["orders:read", "finance:read", "finance:write"],
    observer: ["orders:read"],
  };
  if (commerce[role]?.includes(permission)) return true;
  const inventory: Partial<Record<Role, Permission[]>> = {
    owner: [
      "catalog:read",
      "catalog:write",
      "inventory:read",
      "inventory:write",
      "inventory:sell",
      "inventory:cost",
    ],
    manager: [
      "catalog:read",
      "catalog:write",
      "inventory:read",
      "inventory:write",
      "inventory:sell",
      "inventory:cost",
    ],
    purchasing: [
      "catalog:read",
      "catalog:write",
      "inventory:read",
      "inventory:write",
      "inventory:sell",
      "inventory:cost",
    ],
    sales: ["catalog:read", "inventory:read", "inventory:sell"],
    finance: ["catalog:read", "inventory:read", "inventory:cost"],
    observer: ["catalog:read", "inventory:read"],
  };
  if (inventory[role]?.includes(permission)) return true;
  return grants[role]?.includes(permission) ?? false;
}
export function assertPermission(role: Role, permission: Permission) {
  if (!can(role, permission)) throw new AppError("FORBIDDEN", 403);
}
