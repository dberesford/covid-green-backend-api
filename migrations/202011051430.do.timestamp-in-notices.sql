ALTER TABLE notices
  ALTER COLUMN created_at SET DATA TYPE TIMESTAMPTZ,
  ALTER COLUMN created_at SET DEFAULT CURRENT_TIMESTAMP
;