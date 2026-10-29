import { describe, expect, test } from 'claude-code/testing'

import { splitStatements, tableChanges } from '../hooks/sql'

const BILLING_000028 = `CREATE TABLE IF NOT EXISTS organization_courses (
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    course_id       VARCHAR(64) NOT NULL,
    course_name     VARCHAR(255) NOT NULL,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY (organization_id, course_id)
);

-- Index for the lookup by org (the composite PK already implies it, but
-- it is spelled out for ordering by sort_order).
CREATE INDEX IF NOT EXISTS idx_organization_courses_org_sort
    ON organization_courses (organization_id, sort_order);

INSERT INTO organization_courses (organization_id, course_id, course_name, sort_order) VALUES
    ('5a9c1b60-bdeb-422d-af14-99c7e13595ab', 'ac3677bf-16ba-4545-bf0b-1701e85fd37b', 'La Neuquinidad', 0),
    ('c091f607-d83d-4ffa-adf7-85746c5620e6', '9a87f69c-4e90-46d7-a697-be70331d51b8', 'Everyone — Intro course', 0)
ON CONFLICT (organization_id, course_id) DO NOTHING;
`

const BILLING_000029 = `ALTER TABLE resources ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
`

const ORDERS_000055 = `ALTER TABLE exams
    ADD COLUMN IF NOT EXISTS start_date             DATE NULL,
    ADD COLUMN IF NOT EXISTS end_date               DATE NULL,
    ADD COLUMN IF NOT EXISTS duration_minutes       INT  NOT NULL DEFAULT 20,
    ADD COLUMN IF NOT EXISTS activity_count         INT  NOT NULL DEFAULT 20,
    ADD COLUMN IF NOT EXISTS allowed_activity_types TEXT[] NULL;

ALTER TABLE exams
    ADD CONSTRAINT exams_window_order_chk
        CHECK (start_date IS NULL OR end_date IS NULL OR start_date <= end_date);

ALTER TABLE exams
    ADD CONSTRAINT exams_duration_positive_chk
        CHECK (duration_minutes > 0);

ALTER TABLE exams
    ADD CONSTRAINT exams_activity_count_positive_chk
        CHECK (activity_count > 0);
`

const STORE_000003 = `-- 000003_split_user_name.up.sql
-- Splits users.name into first_name + last_name.

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'users' AND column_name = 'name'
    ) THEN
        ALTER TABLE users RENAME COLUMN name TO first_name;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'users' AND column_name = 'last_name'
    ) THEN
        ALTER TABLE users ADD COLUMN last_name VARCHAR(255) NOT NULL DEFAULT '';
    END IF;
END $$;
`

const STORE_000009 = `-- Time slots (weekly schedule grid)
CREATE TABLE time_slots (
    id          BIGSERIAL    PRIMARY KEY,
    course_id   BIGINT       NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    day_of_week SMALLINT     NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
    start_time  TIME         NOT NULL,
    end_time    TIME         NOT NULL,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE time_slot_subjects (
    id                BIGSERIAL PRIMARY KEY,
    time_slot_id      BIGINT NOT NULL REFERENCES time_slots(id) ON DELETE CASCADE,
    course_subject_id BIGINT NOT NULL REFERENCES course_subjects(id) ON DELETE CASCADE,
    UNIQUE(time_slot_id, course_subject_id)
);

CREATE INDEX idx_time_slots_course_id ON time_slots(course_id);
CREATE INDEX idx_time_slots_course_day ON time_slots(course_id, day_of_week);
CREATE INDEX idx_tss_slot ON time_slot_subjects(time_slot_id);
CREATE INDEX idx_tss_cs ON time_slot_subjects(course_subject_id);

CREATE OR REPLACE FUNCTION validate_time_slot_subject() RETURNS TRIGGER AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM course_subjects cs
        JOIN time_slots ts ON ts.course_id = cs.course_id
        WHERE cs.id = NEW.course_subject_id AND ts.id = NEW.time_slot_id
    ) THEN
        RAISE EXCEPTION 'course_subject does not belong to the same course as the time_slot';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_validate_time_slot_subject
    BEFORE INSERT OR UPDATE ON time_slot_subjects
    FOR EACH ROW
    EXECUTE FUNCTION validate_time_slot_subject();
`

describe('splitStatements', () => {
  test('should keep a $$ body whole and drop comments when it splits on semicolons', () => {
    const statements = splitStatements(STORE_000003)

    expect(statements).toHaveLength(1)
    expect(statements[0]).toStartWith('DO $$ BEGIN')
    expect(statements[0]).toEndWith('END IF; END $$')
  })

  test('should not split on a semicolon inside a quoted string', () => {
    expect(splitStatements("INSERT INTO t VALUES ('a;b'); SELECT 1;")).toEqual(["INSERT INTO t VALUES ('a;b')", 'SELECT 1'])
  })
})

describe('tableChanges', () => {
  test('should list the columns and the foreign key of a new table when it is created', () => {
    const { tables, skipped } = tableChanges(BILLING_000028)

    expect(tables).toEqual([
      {
        table: 'organization_courses',
        isNew: true,
        isDropped: false,
        added: [
          { name: 'organization_id', type: 'UUID' },
          { name: 'course_id', type: 'VARCHAR(64)' },
          { name: 'course_name', type: 'VARCHAR(255)' },
          { name: 'sort_order', type: 'INTEGER' },
          { name: 'created_at', type: 'TIMESTAMP WITH TIME ZONE' },
        ],
        dropped: [],
        renamed: [],
        foreignKeys: [{ column: 'organization_id', table: 'organizations' }],
      },
    ])
    expect(skipped).toBe(2)
  })

  test('should show one added column when an existing table gets it', () => {
    const { tables, skipped } = tableChanges(BILLING_000029)

    expect(tables).toHaveLength(1)
    expect(tables[0]!.isNew).toBe(false)
    expect(tables[0]!.added).toEqual([{ name: 'position', type: 'INTEGER' }])
    expect(skipped).toBe(0)
  })

  test('should list every column of a multi-column ALTER and count the CHECK constraints it cannot show', () => {
    const { tables, skipped } = tableChanges(ORDERS_000055)

    expect(tables.map(table => table.table)).toEqual(['exams'])
    expect(tables[0]!.added).toEqual([
      { name: 'start_date', type: 'DATE' },
      { name: 'end_date', type: 'DATE' },
      { name: 'duration_minutes', type: 'INT' },
      { name: 'activity_count', type: 'INT' },
      { name: 'allowed_activity_types', type: 'TEXT[]' },
    ])
    expect(skipped).toBe(3)
  })

  test('should count a DO block as not interpreted instead of guessing the rename inside it', () => {
    expect(tableChanges(STORE_000003)).toEqual({ tables: [], skipped: 1 })
  })

  test('should keep the foreign keys of each new table and count indexes, functions and triggers when there are several', () => {
    const { tables, skipped } = tableChanges(STORE_000009)

    expect(tables.map(table => table.table)).toEqual(['time_slots', 'time_slot_subjects'])
    expect(tables[0]!.added.find(column => column.name === 'day_of_week')?.type).toBe('SMALLINT')
    expect(tables[1]!.foreignKeys).toEqual([
      { column: 'time_slot_id', table: 'time_slots' },
      { column: 'course_subject_id', table: 'course_subjects' },
    ])
    expect(skipped).toBe(6)
  })

  test('should show dropped, renamed and referencing columns when a migration changes an existing table', () => {
    const sql = `BEGIN;
      ALTER TABLE "users" DROP COLUMN IF EXISTS password_hash, RENAME COLUMN name TO first_name;
      ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'a,b', ADD CONSTRAINT users_org_fk FOREIGN KEY (org_id) REFERENCES orgs(id);
      ALTER TABLE users ALTER COLUMN email TYPE CITEXT;
      DROP TABLE IF EXISTS legacy_sessions CASCADE;
      COMMIT;`

    const { tables, skipped } = tableChanges(sql)

    expect(tables).toEqual([
      {
        table: 'users',
        isNew: false,
        isDropped: false,
        added: [{ name: 'status', type: 'TEXT' }],
        dropped: ['password_hash'],
        renamed: [{ from: 'name', to: 'first_name' }],
        foreignKeys: [{ column: 'org_id', table: 'orgs' }],
      },
      { table: 'legacy_sessions', isNew: false, isDropped: true, added: [], dropped: [], renamed: [], foreignKeys: [] },
    ])
    expect(skipped).toBe(1)
  })
})
