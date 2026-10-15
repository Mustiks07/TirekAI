import { z } from "zod";

// T035–T038 contracts. Coordinates are normalised to 0..1 of the frame, so a configuration does
// not depend on the processing resolution.
const coord = z.number().min(0).max(1);
const point = z.object({ x: coord, y: coord }).strict();
const id = z.string().regex(/^[a-z][a-z0-9_]{0,30}$/);
const name = z.string().trim().min(1).max(60);
export const sourceInput = z
  .object({
    key: z.uuid(),
    branchId: z.uuid(),
    name: z.string().trim().min(2).max(80),
    kind: z.enum(["file", "webcam", "network"]),
    mode: z.enum(["recording", "live"]),
    // Device passport without secrets: camera credentials stay on the processing device.
    passport: z
      .object({
        protocol: z.string().trim().max(40).default(""),
        model: z.string().trim().max(80).default(""),
        time: z.enum(["device", "ntp", "file", "unknown"]).default("unknown"),
        auth: z
          .enum(["none", "basic", "digest", "on_device", "unknown"])
          .default("unknown"),
        access: z
          .enum(["local_network", "file", "usb", "unknown"])
          .default("unknown"),
        note: z.string().trim().max(200).default(""),
      })
      .strict(),
  })
  .strict()
  .refine((s) => s.kind !== "file" || s.mode === "recording", {
    path: ["mode"],
  });
export const lineSchema = z
  .object({
    id,
    name,
    a: point,
    b: point,
    inSide: z.union([z.literal(1), z.literal(-1)]),
  })
  .strict()
  .refine((l) => Math.hypot(l.a.x - l.b.x, l.a.y - l.b.y) >= 0.05, {
    message: "line too short",
  });
export const zoneSchema = z
  .object({
    id,
    name,
    polygon: z.array(point).min(3).max(20),
    kind: z.enum(["presence", "queue", "shelf", "workstation"]),
    queueMin: z.number().int().min(2).max(50).optional(),
    queueSeconds: z.number().int().min(3).max(600).optional(),
  })
  .strict();
export const configInput = z
  .object({
    key: z.uuid(),
    version: z.number().int().min(0),
    lines: z.array(lineSchema).max(10),
    zones: z.array(zoneSchema).max(10),
    note: z.string().trim().min(3).max(200),
  })
  .strict()
  .refine(
    (c) =>
      new Set([...c.lines.map((l) => l.id), ...c.zones.map((z) => z.id)])
        .size ===
      c.lines.length + c.zones.length,
    {
      message: "duplicate ids",
    },
  )
  .refine((c) => c.lines.length + c.zones.length > 0, {
    message: "empty configuration",
  });
export const eventInput = z
  .object({
    seq: z.number().int().nonnegative(),
    kind: z.enum([
      "line_cross",
      "zone_count",
      "dwell",
      "queue_start",
      "queue_end",
      "gap",
      "signal_lost",
      "shelf_change_suspected",
      "workstation_state",
    ]),
    at: z.iso.datetime(),
    until: z.iso.datetime().optional(),
    line: id.optional(),
    zone: id.optional(),
    direction: z.enum(["in", "out"]).optional(),
    value: z.number().finite().min(-1e9).max(1e9).optional(),
    reason: z.string().max(200).optional(),
  })
  .strict();
export const ingestInput = z
  .object({ runId: z.uuid(), events: z.array(eventInput).max(1000) })
  .strict();
export const runStart = z
  .object({
    configVersion: z.number().int().positive(),
    sourceStart: z.iso.datetime(),
    passport: z
      .object({
        codec: z.string().max(40).optional(),
        width: z.number().int().positive().max(10000).optional(),
        height: z.number().int().positive().max(10000).optional(),
        fps: z.number().positive().max(1000).optional(),
      })
      .strict()
      .default({}),
  })
  .strict();
export const heartbeatInput = z
  .object({
    runId: z.uuid(),
    frames: z.number().int().nonnegative(),
    unusable: z.number().int().nonnegative(),
    fps: z.number().nonnegative().max(100000),
    latencyMs: z.number().nonnegative().max(1e6),
    sourceTime: z.iso.datetime(),
  })
  .strict();
export const runEnd = z
  .object({
    runId: z.uuid(),
    ended: z.enum(["end_of_stream", "aborted", "signal_lost", "decoder_error"]),
    summary: z.record(z.string(), z.unknown()),
  })
  .strict();
export const annotationInput = z
  .object({
    kind: z.enum(["line_cross", "queue", "shelf_change", "workstation_state"]),
    atSeconds: z.number().min(0).max(864000),
    untilSeconds: z.number().min(0).max(864000).nullable(),
    line: id.nullable(),
    zone: id.nullable(),
    direction: z.enum(["in", "out"]).nullable(),
  })
  .strict();
