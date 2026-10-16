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
// T057: how people are counted in this run, recorded at its start.
export const pipelineSchema = z
  .object({
    mode: z.enum(["neural", "motion"]),
    detector: z.string().max(80).nullable(),
    tracker: z.enum(["bytetrack", "nearest"]),
    fps: z.number().positive().max(60),
  })
  .strict();
export const runStart = z
  .object({
    configVersion: z.number().int().positive(),
    pipeline: pipelineSchema.optional(),
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
const counts = z.record(id, z.number().int().min(0).max(10000));
const crossings = z.record(
  id,
  z
    .object({
      in: z.number().int().min(0).max(1e9),
      out: z.number().int().min(0).max(1e9),
    })
    .strict(),
);
export const heartbeatInput = z
  .object({
    runId: z.uuid(),
    frames: z.number().int().nonnegative(),
    unusable: z.number().int().nonnegative(),
    // Processing capacity (frames per second of processing time).
    fps: z.number().nonnegative().max(100000),
    // Frames actually received per second of wall time (T057).
    inputFps: z.number().nonnegative().max(1000).optional(),
    latencyMs: z.number().nonnegative().max(1e6),
    sourceTime: z.iso.datetime(),
    // People counted on the latest analyzed frame (not an average).
    now: z
      .object({
        at: z.iso.datetime(),
        visible: z.number().int().min(0).max(10000),
        zones: counts,
        crossings,
      })
      .strict()
      .nullable()
      .optional(),
    diagnosis: z
      .object({
        frames: z.number().int().nonnegative(),
        usable: z.number().int().nonnegative(),
        withDetections: z.number().int().nonnegative(),
        withPeople: z.number().int().nonnegative(),
        inZone: z.record(id, z.number().int().nonnegative()),
        maxScore: z.number().min(0).max(1).nullable(),
      })
      .strict()
      .optional(),
  })
  .strict();
const box = z.tuple([coord, coord, coord, coord]);
const framePeople = z
  .array(
    z
      .object({
        id: z.number().int().nonnegative(),
        box: box.nullable(),
        counted: z.boolean(),
        seen: z.boolean(),
      })
      .strict(),
  )
  .max(200);
// T057 live view: the processing device sends the frame it just analyzed (JPEG, only while
// somebody is watching) with the boxes found on it. Kept in server memory only.
export const previewInput = z
  .object({
    runId: z.uuid(),
    at: z.iso.datetime(),
    image: z.base64().max(700_000),
    width: z.number().int().min(16).max(4096),
    height: z.number().int().min(16).max(4096),
    visible: z.number().int().min(0).max(10000),
    people: framePeople,
    zones: counts,
    crossings,
  })
  .strict();
// T057 analysis in the app: the browser sends frames of its own camera or of a chosen file at
// the detector's size; nothing is stored, boxes and counts come back to the same user.
export const liveStartInput = z
  .object({
    key: z.uuid(),
    kind: z.enum(["camera", "file"]),
    fps: z.number().int().min(1).max(10),
    lines: z.array(lineSchema).max(10),
    zones: z.array(zoneSchema).max(10),
  })
  .strict();
export const liveFrameInput = z
  .object({
    seq: z.number().int().nonnegative(),
    rgb: z.base64().max(1_700_000),
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
