export type Material = { itemId: string; quantity: string; unit: string };
export type Recipe = {
  mode: "food" | "production";
  outputItemId: string;
  outputQuantity: string;
  ingredients: (Material & { lossPercent: string })[];
  stages: string[];
};
export type Production = {
  recipe: Recipe;
  recipeId: string;
  recipeVersion: number;
  warehouseId: string;
  quantity: string;
  salesOrderId: string | null;
  equipmentId: string | null;
  requirements: Material[];
  issued: Material[];
  costMinor: string;
  plannedMaterialCostMinor: string | null;
  stages: boolean[];
  defects: string;
  reworked: string;
  goodQuantity?: string;
  scrapQuantity?: string;
  scrapCostMinor?: string;
  lotCode?: string;
  outputMovementId?: string;
};
export type Resource = {
  resourceKind: "specialist" | "workplace" | "teacher" | "room" | "equipment";
  capacity: number;
  bufferMinutes: number;
  days: number[];
  opens: string;
  closes: string;
};
export type Appointment = {
  mode: "service" | "lesson";
  startsAt: string;
  endsAt: string;
  resources: string[];
  customerId?: string;
  inquiryId?: string | null;
  serviceItemId?: string;
  price?: string;
  warehouseId?: string;
  materials?: Material[];
  groupId?: string;
  orderIds: string[];
  attendance?: { enrollmentId: string; present: boolean }[];
  materialCostMinor?: string;
};
export type Course = {
  serviceItemId: string;
  warehouseId: string;
  lessonPrice: string;
  lessons: number;
};
export type Group = { course: Course; courseId: string; capacity: number };
export type Enrollment = {
  groupId: string;
  customerId: string;
  guardianId: string | null;
  inquiryId: string | null;
  endsOn: string;
  frozenUntil: string | null;
  attended: number;
  lessonLimit: number;
  orderIds: string[];
};
export type Project = {
  quoteId: string;
  quoteVersion: number;
  customerId: string;
  warehouseId: string;
  budget: string;
  estimatedHours: string | null;
  tasks: { id: string; stage: number }[];
  priceMinor: string;
  team: string[];
  stages: string[];
  done: boolean[];
  time: {
    memberId: string;
    stage: number;
    hours: string;
    hourlyRate: string;
    workedOn: string;
    costMinor: string;
    note: string;
  }[];
  costMinor: string;
  change: null | {
    budget: string;
    extraPrice: string;
    description: string;
    authorId: string;
  };
  changes: {
    budget: string;
    extraPrice: string;
    description: string;
    authorId: string;
    approverId: string;
  }[];
  lines: {
    itemId: string;
    quantity: string;
    unit: string;
    price: string;
    discount: string;
  }[];
  orderId: string | null;
};
