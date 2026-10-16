import type { Sql } from "../db/database";
// A substitution fulfills the ordered line but receives another SKU. Material scope and
// comparable savings must follow the physical document line, never relabel it as the ordered SKU.
export function purchaseQuantities(
  tx: Sql,
  org: string,
  orders: string[],
  includeUnreceived = false,
) {
  return tx.query<{ item_id: string; quantity: string }>(
    `SELECT item_id,sum(quantity)::text quantity FROM (
    SELECT d.item_id,r.quantity FROM purchase_receipts r
      JOIN purchase_document_lines d ON d.organization_id=r.organization_id AND d.id=r.document_line_id
      JOIN purchase_lines l ON l.organization_id=r.organization_id AND l.id=r.purchase_line_id
      WHERE l.organization_id=$1 AND l.order_id=ANY($2::uuid[])
    UNION ALL SELECT l.item_id,l.quantity-l.received FROM purchase_lines l
      JOIN purchase_orders o ON o.organization_id=l.organization_id AND o.id=l.order_id
      WHERE l.organization_id=$1 AND l.order_id=ANY($2::uuid[]) AND $3::boolean AND o.state<>'cancelled' AND l.quantity>l.received
  ) q GROUP BY item_id`,
    [org, orders, includeUnreceived],
  );
}
