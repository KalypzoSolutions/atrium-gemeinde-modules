-- Raumplanung: Merkmale, Räume, Sperrzeiten, Buchungen (fest/flexibel, wöchentliche Serien) und
-- die konkreten Raumzuweisungen je Termin. Schema mod_rooms (search_path), Benutzer-IDs ohne Fremdschlüssel.

CREATE TABLE IF NOT EXISTS features (
	id text PRIMARY KEY,
	name text NOT NULL,
	icon text,
	position integer NOT NULL DEFAULT 0,
	created_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT features_name_check CHECK (length(name) BETWEEN 1 AND 60)
);
CREATE UNIQUE INDEX IF NOT EXISTS features_name_idx ON features (lower(name));

CREATE TABLE IF NOT EXISTS rooms (
	id text PRIMARY KEY,
	name text NOT NULL,
	building text,
	description text,
	capacity integer NOT NULL,
	area_m2 numeric(10, 2),
	heating_cost_cents_per_hour bigint NOT NULL DEFAULT 0,
	bookable boolean NOT NULL DEFAULT true,
	position integer NOT NULL DEFAULT 0,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT rooms_capacity_check CHECK (capacity > 0),
	CONSTRAINT rooms_heating_check CHECK (heating_cost_cents_per_hour >= 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS rooms_name_idx ON rooms (lower(name));

CREATE TABLE IF NOT EXISTS room_features (
	room_id text NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
	feature_id text NOT NULL REFERENCES features (id) ON DELETE CASCADE,
	PRIMARY KEY (room_id, feature_id)
);
CREATE INDEX IF NOT EXISTS room_features_feature_idx ON room_features (feature_id);

CREATE TABLE IF NOT EXISTS room_blocks (
	id text PRIMARY KEY,
	room_id text NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
	starts_on date NOT NULL,
	ends_on date NOT NULL,
	reason text,
	created_by text,
	created_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT room_blocks_range_check CHECK (ends_on >= starts_on)
);
CREATE INDEX IF NOT EXISTS room_blocks_room_idx ON room_blocks (room_id, starts_on, ends_on);

CREATE TABLE IF NOT EXISTS bookings (
	id text PRIMARY KEY,
	title text NOT NULL,
	description text,
	owner_id text NOT NULL,
	created_by text,
	mode text NOT NULL,
	fixed_room_id text REFERENCES rooms (id) ON DELETE SET NULL,
	persons integer NOT NULL,
	starts_on date NOT NULL,
	starts_at text NOT NULL,
	ends_at text NOT NULL,
	recurrence jsonb,
	recurrence_until date,
	event_id text,
	managed_by_event boolean NOT NULL DEFAULT false,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT bookings_mode_check CHECK (mode IN ('fixed', 'flexible')),
	CONSTRAINT bookings_persons_check CHECK (persons > 0),
	CONSTRAINT bookings_starts_at_check CHECK (starts_at ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
	CONSTRAINT bookings_ends_at_check CHECK (ends_at ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
	CONSTRAINT bookings_time_order_check CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS bookings_owner_idx ON bookings (owner_id);
CREATE INDEX IF NOT EXISTS bookings_fixed_room_idx ON bookings (fixed_room_id);
CREATE INDEX IF NOT EXISTS bookings_event_idx ON bookings (event_id);
CREATE INDEX IF NOT EXISTS bookings_window_idx ON bookings (starts_on, recurrence_until);
CREATE UNIQUE INDEX IF NOT EXISTS bookings_managed_event_idx ON bookings (event_id)
	WHERE managed_by_event;

CREATE TABLE IF NOT EXISTS booking_features (
	booking_id text NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
	feature_id text NOT NULL REFERENCES features (id) ON DELETE CASCADE,
	PRIMARY KEY (booking_id, feature_id)
);
CREATE INDEX IF NOT EXISTS booking_features_feature_idx ON booking_features (feature_id);

-- Einzelne Termine einer Serie absagen (Schlüssel = ursprüngliches Datum)
CREATE TABLE IF NOT EXISTS booking_exceptions (
	booking_id text NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
	occurrence_date date NOT NULL,
	cancelled boolean NOT NULL DEFAULT true,
	updated_by text,
	updated_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (booking_id, occurrence_date)
);

-- Zuweisung je Termin (nur innerhalb des Planungszeitraums); room_id NULL = ohne Raum
CREATE TABLE IF NOT EXISTS assignments (
	booking_id text NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
	occurrence_date date NOT NULL,
	room_id text REFERENCES rooms (id) ON DELETE SET NULL,
	updated_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (booking_id, occurrence_date)
);
CREATE INDEX IF NOT EXISTS assignments_room_idx ON assignments (room_id, occurrence_date);
CREATE INDEX IF NOT EXISTS assignments_date_idx ON assignments (occurrence_date);
