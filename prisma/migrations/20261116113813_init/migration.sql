-- CreateEnum
CREATE TYPE "appointment_status" AS ENUM ('pending', 'confirmed', 'cancelled', 'completed');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(100) NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "phone" VARCHAR(30),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "services" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(120) NOT NULL,
    "description" TEXT NOT NULL,
    "price" DECIMAL(10,2) NOT NULL,
    "duration_minutes" INTEGER NOT NULL,
    "image_url" TEXT,
    "category" VARCHAR(60) NOT NULL,
    "is_featured" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "services_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appointments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "service_id" UUID NOT NULL,
    "start_time" TIMESTAMPTZ(6) NOT NULL,
    "end_time" TIMESTAMPTZ(6) NOT NULL,
    "status" "appointment_status" NOT NULL DEFAULT 'pending',
    "notes" VARCHAR(500),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "appointments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "services_name_key" ON "services"("name");

-- CreateIndex
CREATE INDEX "services_category_idx" ON "services"("category");

-- CreateIndex
CREATE INDEX "appointments_user_id_start_time_idx" ON "appointments"("user_id", "start_time" DESC);

-- CreateIndex
CREATE INDEX "appointments_status_end_time_idx" ON "appointments"("status", "end_time");

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written additions (Prisma's schema language cannot express these).
-- ---------------------------------------------------------------------------

-- Lets GiST exclusion constraints combine "=" (uuid) with "&&" (range overlap).
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Emails are unique case-insensitively, even if a row were inserted outside the app.
CREATE UNIQUE INDEX "users_email_lower_key" ON "users" (lower("email"));

ALTER TABLE "users" ADD CONSTRAINT "users_name_length" CHECK (length(btrim("name")) >= 2);
ALTER TABLE "services" ADD CONSTRAINT "services_price_nonneg" CHECK ("price" >= 0);
ALTER TABLE "services" ADD CONSTRAINT "services_duration_range" CHECK ("duration_minutes" > 0 AND "duration_minutes" <= 480);
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_time_order" CHECK ("end_time" > "start_time");

-- A service has one provider: no two active bookings may overlap. Enforced by the database,
-- so concurrent requests cannot double-book. Cancelled/completed rows are ignored.
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_no_service_overlap"
  EXCLUDE USING gist ("service_id" WITH =, tstzrange("start_time", "end_time") WITH &&)
  WHERE ("status" IN ('pending', 'confirmed'));

-- A user cannot hold two overlapping active bookings either.
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_no_user_overlap"
  EXCLUDE USING gist ("user_id" WITH =, tstzrange("start_time", "end_time") WITH &&)
  WHERE ("status" IN ('pending', 'confirmed'));
