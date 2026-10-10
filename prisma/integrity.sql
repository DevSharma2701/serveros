
-- ───────────── Hand-written integrity rules (not expressible in schema.prisma) ─────────────
-- This block is appended to the initial migration. Keep it in sync if the migration is recreated.

-- A table can be held by only one active order at a time.
CREATE UNIQUE INDEX "OrderTable_one_active_order_per_table" ON "OrderTable" ("tableId") WHERE "isActive";

-- A cash register can have only one open shift at a time.
CREATE UNIQUE INDEX "CashShift_one_open_per_register" ON "CashShift" ("registerId") WHERE "status" = 'OPEN';

-- A product may have only one active recipe per variant (NULL variant = product default).
CREATE UNIQUE INDEX "Recipe_one_active_per_variant" ON "Recipe" ("productId", COALESCE("variantId", '00000000-0000-0000-0000-000000000000'::uuid)) WHERE "isActive";

-- Stock consumed by an order line can be posted (and reversed) only once per ingredient.
CREATE UNIQUE INDEX "InventoryMovement_once_per_order_item" ON "InventoryMovement" ("refId", "ingredientId", "type") WHERE "refType" = 'ORDER_ITEM';

-- Built-in roles (no restaurant) must have unique keys; NULLs are otherwise not compared.
CREATE UNIQUE INDEX "Role_system_key" ON "Role" ("key") WHERE "restaurantId" IS NULL;

-- Money can never go negative where that would be nonsense.
ALTER TABLE "Order" ADD CONSTRAINT "Order_amounts_check" CHECK ("totalMinor" >= 0 AND "paidMinor" >= 0 AND "refundedMinor" >= 0 AND "refundedMinor" <= "paidMinor");
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_amounts_check" CHECK ("amountMinor" > 0 AND "refundedMinor" >= 0 AND "refundedMinor" <= "amountMinor");
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_amount_check" CHECK ("amountMinor" > 0);
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_quantity_check" CHECK ("quantity" > 0);
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_points_check" CHECK ("loyaltyPoints" >= 0);
