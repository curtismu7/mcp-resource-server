CREATE TABLE IF NOT EXISTS accounts (
  id            TEXT PRIMARY KEY,
  nickname      TEXT NOT NULL,
  type          TEXT NOT NULL,          -- checking | savings | money_market | credit_card
  number_masked TEXT NOT NULL,
  balance       REAL NOT NULL,
  available     REAL NOT NULL,
  currency      TEXT NOT NULL,
  opened        TEXT NOT NULL,          -- YYYY-MM-DD
  status        TEXT NOT NULL           -- open | frozen | closed
);

CREATE TABLE IF NOT EXISTS transactions (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL REFERENCES accounts(id),
  date            TEXT NOT NULL,        -- YYYY-MM-DD
  merchant        TEXT NOT NULL,
  category        TEXT NOT NULL,
  amount          REAL NOT NULL,        -- negative = money out
  status          TEXT NOT NULL,        -- posted | pending
  running_balance REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS cards (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES accounts(id),
  kind        TEXT NOT NULL,            -- debit | credit
  network     TEXT NOT NULL,
  last4       TEXT NOT NULL,
  status      TEXT NOT NULL,            -- active | locked
  expires     TEXT NOT NULL,            -- MM/YY
  daily_limit REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS statements (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL REFERENCES accounts(id),
  period          TEXT NOT NULL,        -- YYYY-MM
  opening_balance REAL NOT NULL,
  closing_balance REAL NOT NULL,
  total_in        REAL NOT NULL,
  total_out       REAL NOT NULL,
  document        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS branches (
  id       TEXT PRIMARY KEY,
  name     TEXT NOT NULL,
  address  TEXT NOT NULL,
  city     TEXT NOT NULL,
  zip      TEXT NOT NULL,
  hours    TEXT NOT NULL,
  services TEXT NOT NULL,
  has_atm  INTEGER NOT NULL
);
