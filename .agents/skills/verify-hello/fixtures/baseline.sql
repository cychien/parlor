DELETE FROM tasks;
INSERT INTO tasks (id, scope, title, done, created_at) VALUES
  ('seed-baseline-1', 'alice', 'Buy milk', false, '2026-01-01T09:00:00Z'),
  ('seed-baseline-2', 'alice', 'Write report', false, '2026-01-01T09:01:00Z'),
  ('seed-baseline-3', 'alice', 'Call Amy', false, '2026-01-01T09:02:00Z');
