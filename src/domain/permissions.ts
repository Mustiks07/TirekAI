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
  | "purchasing:approve";
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
export function can(role: Role, permission: Permission) {
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
