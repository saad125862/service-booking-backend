-- Up Migration

CREATE EXTENSION IF NOT EXISTS citext;      -- case-insensitive email uniqueness
CREATE EXTENSION IF NOT EXISTS btree_gist;  -- lets GiST exclusion constraints mix = and && operators

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- users
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          varchar(100) NOT NULL CHECK (length(btrim(name)) >= 2),
  email         citext NOT NULL UNIQUE,
  password_hash text NOT NULL,
  phone         varchar(30),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER users_set_updated_at
  BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- services
CREATE TABLE services (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             varchar(120) NOT NULL UNIQUE,
  description      text NOT NULL,
  price            numeric(10, 2) NOT NULL CHECK (price >= 0),
  duration_minutes integer NOT NULL CHECK (duration_minutes > 0 AND duration_minutes <= 480),
  image_url        text,
  category         varchar(60) NOT NULL,
  is_featured      boolean NOT NULL DEFAULT false,
  is_active        boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX services_category_idx ON services (category) WHERE is_active;
CREATE INDEX services_featured_idx ON services (is_featured) WHERE is_active AND is_featured;

-- appointments
CREATE TYPE appointment_status AS ENUM ('pending', 'confirmed', 'cancelled', 'completed');

CREATE TABLE appointments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  service_id  uuid NOT NULL REFERENCES services (id) ON DELETE RESTRICT,
  start_time  timestamptz NOT NULL,
  end_time    timestamptz NOT NULL,
  status      appointment_status NOT NULL DEFAULT 'pending',
  notes       varchar(500),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT appointments_time_order CHECK (end_time > start_time),

  -- A service has one provider: no two active bookings may overlap. Enforced by the
  -- database, so concurrent requests cannot double-book. Cancelled/completed rows are ignored.
  CONSTRAINT appointments_no_service_overlap EXCLUDE USING gist (
    service_id WITH =,
    tstzrange(start_time, end_time) WITH &&
  ) WHERE (status IN ('pending', 'confirmed')),

  -- A user cannot hold two overlapping active bookings either.
  CONSTRAINT appointments_no_user_overlap EXCLUDE USING gist (
    user_id WITH =,
    tstzrange(start_time, end_time) WITH &&
  ) WHERE (status IN ('pending', 'confirmed'))
);

CREATE INDEX appointments_user_start_idx ON appointments (user_id, start_time DESC);
CREATE INDEX appointments_status_end_idx ON appointments (status, end_time);

CREATE TRIGGER appointments_set_updated_at
  BEFORE UPDATE ON appointments FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Down Migration

DROP TABLE IF EXISTS appointments;
DROP TYPE IF EXISTS appointment_status;
DROP TABLE IF EXISTS services;
DROP TABLE IF EXISTS users;
DROP FUNCTION IF EXISTS set_updated_at();
