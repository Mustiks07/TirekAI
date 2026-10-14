import { z } from "zod";

export const roles = [
  "owner",
  "manager",
  "sales",
  "purchasing",
  "finance",
  "employee",
  "observer",
] as const;
export const assignableRoles = [
  "manager",
  "sales",
  "purchasing",
  "finance",
  "employee",
  "observer",
] as const;
export type Role = (typeof roles)[number];
export const profiles = [
  "retail",
  "food",
  "services",
  "education",
  "projects",
  "production",
  "construction",
  "clinic",
] as const;
export type Profile = (typeof profiles)[number];
export type Locale = "kk" | "ru";
const name = z.string().trim().min(2).max(100);
export const registerSchema = z
  .object({
    name,
    email: z
      .email()
      .max(254)
      .transform((v) => v.toLowerCase()),
    password: z.string().min(12).max(128),
  })
  .strict();
export const loginSchema = registerSchema.omit({ name: true });
export const organizationSchema = z
  .object({
    name,
    profile: z.enum(profiles),
    timezone: z
      .string()
      .max(64)
      .refine((v) => {
        try {
          new Intl.DateTimeFormat("en", { timeZone: v });
          return true;
        } catch {
          return false;
        }
      })
      .default("Asia/Qyzylorda"),
  })
  .strict();
export const invitationSchema = z
  .object({
    email: z
      .email()
      .max(254)
      .transform((v) => v.toLowerCase()),
    role: z.enum(assignableRoles),
    branchId: z.uuid().nullable().default(null),
  })
  .strict();
export const branchSchema = z.object({ name }).strict();
export const tokenSchema = z
  .object({ token: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
export const idSchema = z.uuid();
export type User = { id: string; name: string; email: string };
export type Organization = {
  id: string;
  name: string;
  profile: Profile;
  timezone: string;
  currency: string;
  data_origin: "synthetic";
  role: Role;
  branch_id: string | null;
};
export type Branch = { id: string; name: string };
export type Member = {
  id: string;
  user_id: string;
  name: string;
  email: string;
  role: Role;
  branch_id: string | null;
  branch_name: string | null;
};
export type Invitation = {
  id: string;
  email: string;
  role: Role;
  branch_id: string | null;
  expires_at: string;
  status: "pending" | "accepted" | "expired" | "revoked";
};
export type AuditEvent = {
  id: string;
  action: string;
  created_at: string;
  actor_name: string | null;
  details: Record<string, string>;
};
export type Workspace = {
  organization: Organization;
  branches: Branch[];
  members: Member[];
  invitations: Invitation[];
  activity: AuditEvent[];
  canManageTeam: boolean;
  canManageOrganization: boolean;
  canReadAudit: boolean;
};
export type SessionView = {
  user: User | null;
  organizations: Organization[];
  localPreview: boolean;
};
