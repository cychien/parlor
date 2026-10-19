DELETE FROM tasks;
INSERT INTO tasks (id, scope, title, done, created_at)
SELECT
  format('seed-large-%s', lpad(n::text, 4, '0')),
  'alice',
  format('Task %s', lpad(n::text, 4, '0')),
  false,
  timestamptz '2026-01-01T09:00:00Z' + n * interval '1 second'
FROM generate_series(1, 1000) AS n;
