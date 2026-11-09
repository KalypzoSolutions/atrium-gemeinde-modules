-- Raumplanung 2.0: Heizaufwand 1–10 statt Euro, Stufe „Raum wie dieser“ (mode 'similar'), Gruppen mit Farbe und
-- Vorrang, Verlegungen mit Widerspruch, von Hand festgelegte Einzeltermine und Tauschanfragen.

-- Heizaufwand je Raum (1 = kaum, 10 = sehr hoch); Bestand aus den bisherigen Heizkosten abgeleitet (2,50 € je Stufe)
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS heating_level smallint NOT NULL DEFAULT 5;
UPDATE rooms
	SET heating_level = LEAST(10, GREATEST(1, CEIL(heating_cost_cents_per_hour / 250.0)))::smallint
	WHERE heating_cost_cents_per_hour > 0;
ALTER TABLE rooms DROP CONSTRAINT IF EXISTS rooms_heating_level_check;
ALTER TABLE rooms ADD CONSTRAINT rooms_heating_level_check CHECK (heating_level BETWEEN 1 AND 10);

-- Drei Stufen: fest, Raum wie dieser (Wunschraum in fixed_room_id), nach Anforderungen
ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_mode_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_mode_check CHECK (mode IN ('fixed', 'similar', 'flexible'));

-- Gruppen (Farbe im Belegungsplan, Vorrang 1 = Fremdnutzung … 4 = Gottesdienst und Kasualien)
CREATE TABLE IF NOT EXISTS groups (
	id text PRIMARY KEY,
	name text NOT NULL,
	color text,
	priority smallint NOT NULL DEFAULT 3,
	position integer NOT NULL DEFAULT 0,
	created_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT groups_name_check CHECK (length(name) BETWEEN 1 AND 80),
	CONSTRAINT groups_color_check CHECK (color IS NULL OR color ~ '^#[0-9a-f]{6}$'),
	CONSTRAINT groups_priority_check CHECK (priority BETWEEN 1 AND 4)
);
CREATE UNIQUE INDEX IF NOT EXISTS groups_name_idx ON groups (lower(name));

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS group_id text REFERENCES groups (id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS bookings_group_idx ON bookings (group_id);

-- Einzeltermin von Hand in einen Raum gelegt (Drag & Drop der Raumverwaltung): gilt für diesen Tag wie „fest“
ALTER TABLE booking_exceptions ADD COLUMN IF NOT EXISTS pinned_room_id text REFERENCES rooms (id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS booking_exceptions_pinned_idx ON booking_exceptions (pinned_room_id);

-- Verlegungen (automatisch oder von Hand) mit Widerspruchsfrist
CREATE TABLE IF NOT EXISTS moves (
	id text PRIMARY KEY,
	booking_id text NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
	occurrence_date date NOT NULL,
	from_room_id text REFERENCES rooms (id) ON DELETE SET NULL,
	to_room_id text REFERENCES rooms (id) ON DELETE SET NULL,
	kind text NOT NULL,
	reason text,
	created_by text,
	created_at timestamptz NOT NULL DEFAULT now(),
	objection_until timestamptz,
	objected_at timestamptz,
	objected_by text,
	objection_note text,
	resolved_at timestamptz,
	resolved_by text,
	CONSTRAINT moves_kind_check CHECK (kind IN ('auto', 'manual'))
);
CREATE INDEX IF NOT EXISTS moves_booking_idx ON moves (booking_id, occurrence_date);
CREATE INDEX IF NOT EXISTS moves_from_room_idx ON moves (from_room_id);
CREATE INDEX IF NOT EXISTS moves_to_room_idx ON moves (to_room_id);
CREATE INDEX IF NOT EXISTS moves_open_idx ON moves (objected_at) WHERE resolved_at IS NULL;

-- Tauschanfragen: eine Gruppe möchte den Raum einer festen Buchung an einem Tag
CREATE TABLE IF NOT EXISTS swap_requests (
	id text PRIMARY KEY,
	requester_id text NOT NULL,
	request jsonb NOT NULL,
	target_booking_id text NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
	occurrence_date date NOT NULL,
	room_id text NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
	proposed_room_id text REFERENCES rooms (id) ON DELETE SET NULL,
	message text,
	status text NOT NULL DEFAULT 'pending',
	due_on date NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	decided_at timestamptz,
	decided_by text,
	result_booking_id text REFERENCES bookings (id) ON DELETE SET NULL,
	CONSTRAINT swap_requests_status_check CHECK (status IN ('pending', 'accepted', 'declined', 'expired', 'withdrawn'))
);
CREATE INDEX IF NOT EXISTS swap_requests_target_idx ON swap_requests (target_booking_id);
CREATE INDEX IF NOT EXISTS swap_requests_room_idx ON swap_requests (room_id);
CREATE INDEX IF NOT EXISTS swap_requests_proposed_idx ON swap_requests (proposed_room_id);
CREATE INDEX IF NOT EXISTS swap_requests_result_idx ON swap_requests (result_booking_id);
CREATE INDEX IF NOT EXISTS swap_requests_requester_idx ON swap_requests (requester_id);
CREATE INDEX IF NOT EXISTS swap_requests_open_idx ON swap_requests (status, due_on);
