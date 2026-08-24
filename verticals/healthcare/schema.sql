CREATE TABLE IF NOT EXISTS patients (
  id         TEXT PRIMARY KEY,
  full_name  TEXT NOT NULL,
  dob        TEXT NOT NULL,
  mrn        TEXT NOT NULL,
  primary_physician TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS records (
  id         TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL REFERENCES patients(id),
  date       TEXT NOT NULL,
  type       TEXT NOT NULL,   -- visit | lab | imaging | immunization
  provider   TEXT NOT NULL,
  summary    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS appointments (
  id         TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL REFERENCES patients(id),
  datetime   TEXT NOT NULL,   -- YYYY-MM-DDTHH:MM
  provider   TEXT NOT NULL,
  location   TEXT NOT NULL,
  reason     TEXT NOT NULL,
  status     TEXT NOT NULL    -- scheduled | completed | cancelled
);

CREATE TABLE IF NOT EXISTS prescriptions (
  id          TEXT PRIMARY KEY,
  patient_id  TEXT NOT NULL REFERENCES patients(id),
  medication  TEXT NOT NULL,
  dosage      TEXT NOT NULL,
  prescriber  TEXT NOT NULL,
  refills_left INTEGER NOT NULL,
  status      TEXT NOT NULL   -- active | expired
);
