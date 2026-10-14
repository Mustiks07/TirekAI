import { AppError } from "./errors";
import type { Role } from "./contracts";
export type Permission =
  | "organization:read"
  | "organization:write"
  | "team:read"
  | "team:write"
  | "audit:read";
const grants: Record<Role, readonly Permission[]> = {
  owner: [
    "organization:read",
    "organization:write",
    "team:read",
    "team:write",
    "audit:read",
  ],
  manager: ["organization:read", "team:read", "audit:read"],
  sales: ["organization:read"],
  purchasing: ["organization:read"],
  finance: ["organization:read"],
  employee: ["organization:read"],
  observer: ["organization:read"],
};
export function can(role: Role, permission: Permission) {
  return grants[role]?.includes(permission) ?? false;
}
export function assertPermission(role: Role, permission: Permission) {
  if (!can(role, permission)) throw new AppError("FORBIDDEN", 403);
}
