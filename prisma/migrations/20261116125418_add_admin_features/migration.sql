-- CreateEnum
CREATE TYPE "field_type" AS ENUM ('text', 'textarea', 'number', 'boolean', 'select');

-- CreateEnum
CREATE TYPE "discount_status" AS ENUM ('pending', 'approved', 'declined', 'used');

-- CreateEnum
CREATE TYPE "payment_type" AS ENUM ('cash', 'card', 'mobile_wallet', 'bank');

-- CreateEnum
CREATE TYPE "payment_status" AS ENUM ('unpaid', 'submitted', 'paid', 'failed');

-- AlterTable
ALTER TABLE "appointments" ADD COLUMN     "discount_amount" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "original_price" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "paid_at" TIMESTAMPTZ(6),
ADD COLUMN     "payment_method_id" UUID,
ADD COLUMN     "payment_reference" VARCHAR(60),
ADD COLUMN     "payment_status" "payment_status" NOT NULL DEFAULT 'unpaid',
ADD COLUMN     "price" DECIMAL(10,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "services" ADD COLUMN     "attributes" JSONB NOT NULL DEFAULT '{}';

-- CreateTable
CREATE TABLE "service_fields" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "key" VARCHAR(40) NOT NULL,
    "label" VARCHAR(80) NOT NULL,
    "type" "field_type" NOT NULL,
    "options" JSONB,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_fields_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "discount_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "service_id" UUID,
    "message" VARCHAR(500) NOT NULL,
    "language" VARCHAR(10) NOT NULL DEFAULT 'en',
    "status" "discount_status" NOT NULL DEFAULT 'pending',
    "discount_type" VARCHAR(10),
    "discount_value" DECIMAL(10,2),
    "admin_note" VARCHAR(300),
    "reply" VARCHAR(1000),
    "decided_by" UUID,
    "decided_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6),
    "used_appointment_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "discount_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_methods" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" VARCHAR(30) NOT NULL,
    "name" VARCHAR(60) NOT NULL,
    "type" "payment_type" NOT NULL,
    "instructions" VARCHAR(500),
    "account_number" VARCHAR(40),
    "requires_reference" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_methods_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "service_fields_key_key" ON "service_fields"("key");

-- CreateIndex
CREATE INDEX "discount_requests_user_id_created_at_idx" ON "discount_requests"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "discount_requests_status_created_at_idx" ON "discount_requests"("status", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "payment_methods_code_key" ON "payment_methods"("code");

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_payment_method_id_fkey" FOREIGN KEY ("payment_method_id") REFERENCES "payment_methods"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discount_requests" ADD CONSTRAINT "discount_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "discount_requests" ADD CONSTRAINT "discount_requests_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written additions
-- ---------------------------------------------------------------------------

-- Existing bookings get a price snapshot from their service's current price.
UPDATE "appointments" a
   SET "price" = s."price", "original_price" = s."price"
  FROM "services" s
 WHERE a."service_id" = s."id" AND a."original_price" = 0;

ALTER TABLE "appointments" ADD CONSTRAINT "appointments_amounts_valid"
  CHECK ("price" >= 0 AND "original_price" >= 0 AND "discount_amount" >= 0 AND "discount_amount" <= "original_price");

ALTER TABLE "discount_requests" ADD CONSTRAINT "discount_requests_value_valid"
  CHECK ("discount_value" IS NULL OR "discount_value" > 0);
ALTER TABLE "discount_requests" ADD CONSTRAINT "discount_requests_type_valid"
  CHECK ("discount_type" IS NULL OR "discount_type" IN ('percent', 'fixed'));
