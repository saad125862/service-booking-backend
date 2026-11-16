-- Online (gateway) payments: which methods go through a gateway, and one row per payment attempt.
ALTER TABLE "payment_methods" ADD COLUMN "gateway_provider" VARCHAR(20);

CREATE TABLE "payment_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "appointment_id" UUID NOT NULL,
    "provider" VARCHAR(20) NOT NULL,
    "tran_id" VARCHAR(64) NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'BDT',
    "status" VARCHAR(12) NOT NULL DEFAULT 'initiated',
    "gateway_url" VARCHAR(1000),
    "gateway_ref" VARCHAR(80),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "payment_sessions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "payment_sessions_tran_id_key" ON "payment_sessions"("tran_id");
CREATE INDEX "payment_sessions_appointment_id_created_at_idx" ON "payment_sessions"("appointment_id", "created_at" DESC);

ALTER TABLE "payment_sessions" ADD CONSTRAINT "payment_sessions_appointment_id_fkey"
    FOREIGN KEY ("appointment_id") REFERENCES "appointments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "payment_sessions" ADD CONSTRAINT "payment_sessions_status_check"
    CHECK ("status" IN ('initiated', 'paid', 'failed', 'cancelled'));
