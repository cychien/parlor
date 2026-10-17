DELETE FROM tasks;
INSERT INTO tasks (id, title, done, created_at) VALUES
  ('seed-baseline-1', 'Buy milk', false, '2026-01-01T09:00:00Z'),
  ('seed-baseline-2', 'Write report', false, '2026-01-01T09:01:00Z'),
  ('seed-baseline-3', 'Call Amy', false, '2026-01-01T09:02:00Z');
