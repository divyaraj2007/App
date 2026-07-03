const Database = require("better-sqlite3");
const crypto = require("crypto");
const path = require("path");

const db = new Database(path.join(__dirname, "attendance.db"));

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS people (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
    role TEXT NOT NULL DEFAULT 'student' CHECK (role IN ('student', 'teacher')),
    subject TEXT NOT NULL DEFAULT '',
    standard TEXT NOT NULL DEFAULT '',
    face_template TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS attendance (
    person_id TEXT NOT NULL,
    date TEXT NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    status TEXT NOT NULL CHECK (status IN ('present', 'absent', 'late')),
    note TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (person_id, date),
    FOREIGN KEY (person_id) REFERENCES people(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE CHECK (length(trim(username)) BETWEEN 3 AND 40),
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('student', 'teacher', 'principal')),
    person_id TEXT UNIQUE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (person_id) REFERENCES people(id) ON DELETE CASCADE
  );
`);

ensureColumn("people", "role", "TEXT NOT NULL DEFAULT 'student' CHECK (role IN ('student', 'teacher'))");
ensureColumn("people", "subject", "TEXT NOT NULL DEFAULT ''");
ensureColumn("people", "standard", "TEXT NOT NULL DEFAULT ''");
ensureColumn("people", "face_template", "TEXT NOT NULL DEFAULT ''");
seedDefaults();

const statements = {
  listPeopleWithAttendance: db.prepare(`
    SELECT
      p.id,
      p.name,
      p.role,
      p.subject,
      p.standard,
      CASE WHEN p.face_template != '' THEN 1 ELSE 0 END AS faceEnrolled,
      COALESCE(a.status, 'absent') AS status,
      COALESCE(a.note, '') AS note
    FROM people p
    LEFT JOIN attendance a ON a.person_id = p.id AND a.date = @date
    WHERE p.role = @role
    ORDER BY p.created_at ASC, p.name ASC
  `),
  createPerson: db.prepare("INSERT INTO people (id, name, role, subject, standard, face_template) VALUES (?, ?, ?, ?, ?, ?)"),
  deletePerson: db.prepare("DELETE FROM people WHERE id = ?"),
  upsertAttendance: db.prepare(`
    INSERT INTO attendance (person_id, date, status, note, updated_at)
    VALUES (@personId, @date, @status, @note, CURRENT_TIMESTAMP)
    ON CONFLICT(person_id, date) DO UPDATE SET
      status = excluded.status,
      note = excluded.note,
      updated_at = CURRENT_TIMESTAMP
  `),
  findAttendance: db.prepare("SELECT status, note FROM attendance WHERE person_id = ? AND date = ?"),
  findPerson: db.prepare("SELECT id, name, role, subject, standard FROM people WHERE id = ?"),
  updateFaceTemplate: db.prepare("UPDATE people SET face_template = ? WHERE id = ?"),
  listFaceCandidates: db.prepare(`
    SELECT id, name, role, subject, standard, face_template AS faceTemplate
    FROM people
    WHERE role = ? AND face_template != ''
  `),
  findUserByUsername: db.prepare(`
    SELECT u.id, u.username, u.password_hash AS passwordHash, u.role, u.person_id AS personId, p.name
    FROM users u
    LEFT JOIN people p ON p.id = u.person_id
    WHERE u.username = ?
  `),
  findUserById: db.prepare(`
    SELECT u.id, u.username, u.role, u.person_id AS personId, p.name
    FROM users u
    LEFT JOIN people p ON p.id = u.person_id
    WHERE u.id = ?
  `),
  createUser: db.prepare(`
    INSERT INTO users (id, username, password_hash, role, person_id)
    VALUES (?, ?, ?, ?, ?)
  `),
  findPersonByNameRole: db.prepare("SELECT id FROM people WHERE name = ? AND role = ?")
};

function listAttendance(date, role) {
  return statements.listPeopleWithAttendance.all({ date, role });
}

function createPerson(name, role, details = {}) {
  const person = {
    id: crypto.randomUUID(),
    name,
    role,
    subject: role === "teacher" ? details.subject || "" : "",
    standard: role === "student" ? details.standard || "" : "",
    faceEnrolled: 0
  };
  const create = db.transaction(() => {
    statements.createPerson.run(person.id, person.name, person.role, person.subject, person.standard, "");
    upsertPersonLogin(person.id, person.name, person.role);
  });

  create();
  return person;
}

function deletePerson(id, requiredRole) {
  const person = statements.findPerson.get(id);

  if (!person || (requiredRole && person.role !== requiredRole)) {
    return false;
  }

  return statements.deletePerson.run(id).changes > 0;
}

function updateFaceTemplate(id, template, requiredRole) {
  const person = statements.findPerson.get(id);

  if (!person || person.role !== requiredRole) {
    return null;
  }

  statements.updateFaceTemplate.run(template, id);
  return { ...person, faceEnrolled: 1 };
}

function listFaceCandidates(role) {
  return statements.listFaceCandidates.all(role);
}

function saveAttendance(personId, date, updates, requiredRole) {
  const person = statements.findPerson.get(personId);

  if (!person || person.role !== requiredRole) {
    return null;
  }

  const existing = statements.findAttendance.get(personId, date);
  const status = updates.status || existing?.status || "absent";
  const note = updates.note ?? existing?.note ?? "";

  statements.upsertAttendance.run({ personId, date, status, note });
  return { personId, date, status, note };
}

function markAll(date, status, role) {
  const people = db.prepare("SELECT id FROM people WHERE role = ?").all(role);
  const mark = db.transaction(() => {
    people.forEach((person) => {
      saveAttendance(person.id, date, { status }, role);
    });
  });

  mark();
}

function findUserByUsername(username) {
  return statements.findUserByUsername.get(username);
}

function findUserById(id) {
  return statements.findUserById.get(id);
}

function verifyPassword(password, passwordHash) {
  const [salt, expected] = passwordHash.split(":");
  const actual = hashPassword(password, salt).split(":")[1];
  return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();

  if (!columns.some((entry) => entry.name === column)) {
    db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
  }
}

function seedDefaults() {
  const defaultStudents = [
    { name: "Aarav Sharma", standard: "10-A" },
    { name: "Diya Patel", standard: "10-A" },
    { name: "Kabir Singh", standard: "9-B" },
    { name: "Meera Joshi", standard: "9-B" },
    { name: "Rohan Verma", standard: "8-C" }
  ];
  const defaultTeachers = [
    { name: "Anita Rao", subject: "Mathematics" },
    { name: "Vikram Mehta", subject: "Science" }
  ];

  const seed = db.transaction(() => {
    defaultStudents.forEach((student) => ensurePersonUser(student, "student"));
    defaultTeachers.forEach((teacher) => ensurePersonUser(teacher, "teacher"));
    ensurePrincipal();
  });

  seed();
}

function ensurePersonUser(entry, role) {
  let person = db.prepare("SELECT id FROM people WHERE name = ? AND role = ?").get(entry.name, role);

  if (!person) {
    const id = crypto.randomUUID();
    db.prepare("INSERT INTO people (id, name, role, subject, standard, face_template) VALUES (?, ?, ?, ?, ?, ?)").run(
      id,
      entry.name,
      role,
      role === "teacher" ? entry.subject || "" : "",
      role === "student" ? entry.standard || "" : "",
      ""
    );
    person = { id };
  } else {
    db.prepare(`
      UPDATE people
      SET subject = CASE WHEN role = 'teacher' AND subject = '' THEN ? ELSE subject END,
          standard = CASE WHEN role = 'student' AND standard = '' THEN ? ELSE standard END
      WHERE id = ?
    `).run(entry.subject || "", entry.standard || "", person.id);
  }

  upsertPersonLogin(person.id, entry.name, role);
}

function upsertPersonLogin(personId, name, role) {
  const user = db.prepare("SELECT id FROM users WHERE person_id = ?").get(personId);
  const usernameOwner = db.prepare("SELECT id, person_id AS personId FROM users WHERE username = ?").get(name);
  const password = `${name}123`;

  if (usernameOwner && usernameOwner.personId !== personId) {
    return;
  }

  if (user) {
    db.prepare(`
      UPDATE users
      SET username = ?, password_hash = ?, role = ?
      WHERE id = ?
    `).run(name, hashPassword(password), role, user.id);
  } else {
    db.prepare(`
      INSERT INTO users (id, username, password_hash, role, person_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(crypto.randomUUID(), name, hashPassword(password), role, personId);
  }
}

function ensurePrincipal() {
  const user = db.prepare("SELECT id FROM users WHERE username = ?").get("principal");

  if (!user) {
    db.prepare(`
      INSERT INTO users (id, username, password_hash, role, person_id)
      VALUES (?, ?, ?, ?, NULL)
    `).run(crypto.randomUUID(), "principal", hashPassword("principal123"), "principal");
  }
}

module.exports = {
  db,
  listAttendance,
  createPerson,
  deletePerson,
  saveAttendance,
  markAll,
  updateFaceTemplate,
  listFaceCandidates,
  findUserByUsername,
  findUserById,
  verifyPassword
};
