DELETE FROM tasks;
INSERT INTO tasks (id, title, done, notes, created_at) VALUES
  ('seed-notes-1', 'Buy milk', false, '2 litres, semi-skimmed', '2026-01-01T09:00:00Z'),
  ('seed-notes-2', 'Write report', false, 'Due Friday', '2026-01-01T09:01:00Z'),
  ('seed-notes-3', 'Call Amy', false, NULL, '2026-01-01T09:02:00Z');
