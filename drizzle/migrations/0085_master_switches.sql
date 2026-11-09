-- #4874 — each time the board changed master: from which machine to which,
-- when, by whom, at which revision. Written once, by the new master, when the
-- switch commits; copied to the nodes with the board's other tables.
CREATE TABLE `master_switches` (
    `id` INTEGER PRIMARY KEY,
    `from_machine` TEXT NOT NULL,
    `from_url` TEXT NOT NULL,
    `to_machine` TEXT NOT NULL,
    `to_url` TEXT NOT NULL,
    `rev` INTEGER NOT NULL,
    `by` TEXT,
    `at` TEXT NOT NULL
);
