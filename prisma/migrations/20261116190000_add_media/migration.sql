-- Uploaded photos (service pictures) kept in the database.
CREATE TABLE "media" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "mime_type" VARCHAR(30) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "uploaded_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "media" ADD CONSTRAINT "media_mime_check" CHECK ("mime_type" IN ('image/jpeg', 'image/png', 'image/webp'));
