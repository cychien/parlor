DELETE FROM tasks;
INSERT INTO tasks (id, title, done, created_at)
SELECT
  format('seed-s30-%s', lpad(n::text, 2, '0')),
  format('Task %s', lpad(n::text, 2, '0')),
  false,
  timestamptz '2026-01-01T09:00:00Z' + n * interval '1 minute'
FROM generate_series(1, 30) AS n;
