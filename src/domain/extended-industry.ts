import { z } from "zod";
import { amount, positive } from "./commerce";
const note = z.string().trim().min(3).max(250);
const title = z.string().trim().min(2).max(120);
const money = z.string().regex(/^(0|[1-9]\d{0,14})(\.\d{1,2})?$/);
const base = { key: z.uuid(), branchId: z.uuid(), note };
const change = {
  key: z.uuid(),
  id: z.uuid(),
  version: z.number().int().positive(),
  note,
};
export const estimateLine = z
  .object({
    itemId: z.uuid(),
    quantity: positive,
    unit: z.string().min(1).max(20),
    price: amount,
  })
  .strict();
const estimate = {
  budget: money,
  lines: z.array(estimateLine).min(1).max(30),
  stages: z.array(title).min(1).max(20),
};
const slot = {
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }),
  resources: z.array(z.uuid()).min(2).max(8),
};
export const extendedIndustryCommands = [
  z
    .object({
      ...base,
      ...estimate,
      kind: z.literal("construction"),
      title,
      customerId: z.uuid(),
      warehouseId: z.uuid(),
      billingItemId: z.uuid(),
    })
    .strict(),
  z
    .object({ ...change, ...estimate, kind: z.literal("construction_revise") })
    .strict(),
  z.object({ ...change, kind: z.literal("construction_approve") }).strict(),
  z
    .object({
      ...change,
      kind: z.literal("construction_purchase"),
      supplierId: z.uuid(),
      date: z.iso.date(),
      dueDate: z.iso.date(),
      lines: z
        .array(z.object({ offerId: z.uuid(), quantity: positive }).strict())
        .min(1)
        .max(30),
    })
    .strict(),
  z
    .object({
      ...change,
      kind: z.literal("construction_materials"),
      materials: z
        .array(
          z
            .object({
              itemId: z.uuid(),
              quantity: positive,
              unit: z.string().min(1).max(20),
            })
            .strict(),
        )
        .min(1)
        .max(30),
    })
    .strict(),
  z
    .object({
      ...change,
      kind: z.literal("construction_work"),
      stage: z.number().int().min(0),
      contractorId: z.uuid(),
      amount: money,
      evidence: note,
    })
    .strict(),
  z
    .object({
      ...change,
      kind: z.literal("construction_confirm"),
      workId: z.uuid(),
    })
    .strict(),
  z.object({ ...change, kind: z.literal("construction_accept") }).strict(),
  // This is an administrative request, not a medical record. No diagnoses or clinical notes.
  z
    .object({
      ...base,
      kind: z.literal("clinic"),
      patientName: title,
      contact: z.string().trim().max(80),
      serviceItemId: z.uuid(),
      warehouseId: z.uuid(),
      price: money,
    })
    .strict(),
  z.object({ ...change, ...slot, kind: z.literal("clinic_book") }).strict(),
  z
    .object({
      ...change,
      kind: z.literal("clinic_visit"),
      outcome: z.enum(["visited", "no_show", "cancelled"]),
    })
    .strict(),
  z.object({ ...change, kind: z.literal("clinic_invoice") }).strict(),
] as const;
export type Construction = {
  customerId: string;
  warehouseId: string;
  billingItemId: string;
  budget: string;
  lines: z.infer<typeof estimateLine>[];
  stages: string[];
  estimateVersion: number;
  authorId: string;
  approverId: string | null;
  priceMinor: string;
  materialCostMinor: string;
  issued: { itemId: string; quantity: string; unit: string }[];
  purchases: string[];
  work: {
    id: string;
    stage: number;
    contractorId: string;
    amount: string;
    evidence: string;
    authorId: string;
    confirmedBy: string | null;
    obligationId?: string;
  }[];
  orderId: string | null;
};
export type Clinic = {
  patientName: string;
  contact: string;
  serviceItemId: string;
  warehouseId: string;
  price: string;
  startsAt?: string;
  endsAt?: string;
  resources?: string[];
  orderId: string | null;
};
