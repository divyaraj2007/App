const crypto = require("crypto");
const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const path = require("path");
const { z } = require("zod");
const {
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
} = require("./database");

const app = express();
const port = Number(process.env.PORT || 3000);
const sessions = new Map();

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const idSchema = z.string().uuid();
const nameSchema = z.string().trim().min(1).max(80);
const statusSchema = z.enum(["present", "absent", "late"]);
const noteSchema = z.string().trim().max(240);
const roleSchema = z.enum(["student", "teacher"]);
const targetSchema = z.enum(["students", "teachers"]);
const detailSchema = z.string().trim().min(1).max(80);
const faceSignatureSchema = z.array(z.number().min(-1).max(1)).length(64);
const faceMatchThreshold = 0.85;

app.disable("x-powered-by");
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", "data:", "https://images.unsplash.com"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"]
      }
    }
  })
);
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 300,
    standardHeaders: "draft-8",
    legacyHeaders: false
  })
);
app.use(express.json({ limit: "20kb" }));
app.use(express.static(path.join(__dirname, "public")));

app.post("/api/login", (req, res) => {
  const parsed = z
    .object({
      username: z.string().trim().min(3).max(40),
      password: z.string().min(6).max(120)
    })
    .safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ error: "Enter a valid username and password." });
  }

  const user = findUserByUsername(parsed.data.username);

  if (!user || !verifyPassword(parsed.data.password, user.passwordHash)) {
    return res.status(401).json({ error: "Invalid login." });
  }

  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { userId: user.id, createdAt: Date.now() });

  return res.json({
    token,
    user: publicUser(user)
  });
});

app.post("/api/logout", authenticate, (req, res) => {
  sessions.delete(req.token);
  return res.status(204).end();
});

app.get("/api/me", authenticate, (req, res) => {
  return res.json(publicUser(req.user));
});

app.get("/api/attendance", authenticate, (req, res) => {
  const parsed = z
    .object({
      date: dateSchema,
      target: targetSchema.optional()
    })
    .safeParse(req.query);

  if (!parsed.success) {
    return res.status(400).json({ error: "Use a valid date and attendance target." });
  }

  const target = resolveTarget(req.user, parsed.data.target);

  if (!target) {
    return res.status(403).json({ error: "You cannot view this attendance register." });
  }

  let people = listAttendance(parsed.data.date, target.role);

  if (req.user.role === "student") {
    people = people.filter((person) => person.id === req.user.personId);
  }

  return res.json({
    date: parsed.data.date,
    target: target.name,
    people,
    summary: summarize(people)
  });
});

app.post("/api/people", authenticate, requireAnyRole(["teacher", "principal"]), (req, res) => {
  const parsed = z
    .object({
      name: nameSchema,
      role: roleSchema,
      subject: detailSchema.optional(),
      standard: detailSchema.optional()
    })
    .superRefine((value, context) => {
      if (value.role === "teacher" && !value.subject) {
        context.addIssue({
          code: "custom",
          message: "Subject is required for teachers.",
          path: ["subject"]
        });
      }

      if (value.role === "student" && !value.standard) {
        context.addIssue({
          code: "custom",
          message: "Standard is required for students.",
          path: ["standard"]
        });
      }
    })
    .safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ error: "Name and class/subject details are required." });
  }

  if (!canManageRole(req.user.role, parsed.data.role)) {
    return res.status(403).json({ error: "You cannot add this type of person." });
  }

  return res.status(201).json(createPerson(parsed.data.name, parsed.data.role, {
    subject: parsed.data.subject,
    standard: parsed.data.standard
  }));
});

app.delete("/api/people/:id", authenticate, requireAnyRole(["teacher", "principal"]), (req, res) => {
  const parsed = idSchema.safeParse(req.params.id);

  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid person id." });
  }

  const requiredRole = req.user.role === "principal" ? null : "student";

  if (!deletePerson(parsed.data, requiredRole)) {
    return res.status(404).json({ error: "Person not found." });
  }

  return res.status(204).end();
});

app.patch("/api/people/:id/face", authenticate, requireAnyRole(["teacher", "principal"]), (req, res) => {
  const params = z.object({ id: idSchema }).safeParse(req.params);
  const body = z
    .object({
      target: targetSchema,
      signature: faceSignatureSchema
    })
    .safeParse(req.body);

  if (!params.success || !body.success) {
    return res.status(400).json({ error: "Capture a clear face before saving." });
  }

  const target = resolveTarget(req.user, body.data.target);

  if (!target || !canManageRole(req.user.role, target.role)) {
    return res.status(403).json({ error: "You cannot enroll faces in this register." });
  }

  const person = updateFaceTemplate(params.data.id, JSON.stringify(body.data.signature), target.role);

  if (!person) {
    return res.status(404).json({ error: "Person not found in this register." });
  }

  return res.json(person);
});

app.patch("/api/attendance/:personId", authenticate, (req, res) => {
  const params = z.object({ personId: idSchema }).safeParse(req.params);
  const body = z
    .object({
      date: dateSchema,
      target: targetSchema,
      status: statusSchema.optional(),
      note: noteSchema.optional()
    })
    .refine((value) => value.status !== undefined || value.note !== undefined)
    .safeParse(req.body);

  if (!params.success || !body.success) {
    return res.status(400).json({ error: "Invalid attendance update." });
  }

  const target = resolveWritableTarget(req.user, body.data.target);

  if (!target) {
    return res.status(403).json({ error: "You cannot mark this attendance register." });
  }

  const record = saveAttendance(params.data.personId, body.data.date, {
    status: body.data.status,
    note: body.data.note
  }, target.role);

  if (!record) {
    return res.status(404).json({ error: "Person not found in this register." });
  }

  return res.json(record);
});

app.post("/api/attendance/mark-all", authenticate, (req, res) => {
  const parsed = z.object({ date: dateSchema, target: targetSchema, status: statusSchema }).safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid mark-all request." });
  }

  const target = resolveWritableTarget(req.user, parsed.data.target);

  if (!target) {
    return res.status(403).json({ error: "You cannot mark this attendance register." });
  }

  markAll(parsed.data.date, parsed.data.status, target.role);
  return res.status(204).end();
});

app.post("/api/attendance/face", authenticate, requireAnyRole(["teacher", "principal"]), (req, res) => {
  const parsed = z
    .object({
      date: dateSchema,
      target: targetSchema,
      signature: faceSignatureSchema
    })
    .safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ error: "Capture a clear face before marking attendance." });
  }

  const target = resolveWritableTarget(req.user, parsed.data.target);

  if (!target) {
    return res.status(403).json({ error: "You cannot mark this attendance register." });
  }

  const match = findFaceMatch(parsed.data.signature, target.role);

  if (!match) {
    return res.status(404).json({ error: "No matching enrolled face was found." });
  }

  saveAttendance(match.person.id, parsed.data.date, { status: "present" }, target.role);
  return res.json({
    person: {
      id: match.person.id,
      name: match.person.name,
      role: match.person.role,
      subject: match.person.subject,
      standard: match.person.standard
    },
    distance: match.distance,
    status: "present"
  });
});

app.use((err, req, res, next) => {
  console.error(err);
  return res.status(500).json({ error: "Server error." });
});

app.listen(port, () => {
  console.log(`Attendance app running at http://localhost:${port}`);
});

function authenticate(req, res, next) {
  const header = req.get("authorization") || "";
  const [scheme, token] = header.split(" ");

  if (scheme !== "Bearer" || !token || !sessions.has(token)) {
    return res.status(401).json({ error: "Login required." });
  }

  const session = sessions.get(token);
  const user = findUserById(session.userId);

  if (!user) {
    sessions.delete(token);
    return res.status(401).json({ error: "Login required." });
  }

  req.token = token;
  req.user = user;
  return next();
}

function requireAnyRole(roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: "You do not have permission." });
    }

    return next();
  };
}

function resolveTarget(user, requestedTarget) {
  if (user.role === "student") {
    return { name: "students", role: "student" };
  }

  if (user.role === "teacher") {
    return { name: "students", role: "student" };
  }

  if (user.role === "principal" && requestedTarget === "teachers") {
    return { name: "teachers", role: "teacher" };
  }

  if (user.role === "principal") {
    return { name: "students", role: "student" };
  }

  return null;
}

function resolveWritableTarget(user, requestedTarget) {
  if (user.role === "teacher" && requestedTarget === "students") {
    return { name: "students", role: "student" };
  }

  if (user.role === "principal" && requestedTarget === "teachers") {
    return { name: "teachers", role: "teacher" };
  }

  return null;
}

function canManageRole(userRole, personRole) {
  return (userRole === "teacher" && personRole === "student") || (userRole === "principal" && ["student", "teacher"].includes(personRole));
}

function summarize(people) {
  return {
    present: people.filter((person) => person.status === "present").length,
    absent: people.filter((person) => person.status === "absent").length,
    late: people.filter((person) => person.status === "late").length,
    total: people.length
  };
}

function findFaceMatch(signature, role) {
  const candidates = listFaceCandidates(role)
    .map((person) => ({ ...person, signature: parseFaceTemplate(person.faceTemplate) }))
    .filter((person) => person.signature);

  let best = null;

  candidates.forEach((person) => {
    const distance = faceDistance(signature, person.signature);

    if (!best || distance < best.distance) {
      best = { person, distance };
    }
  });

  if (!best || best.distance > faceMatchThreshold) {
    return null;
  }

  return best;
}

function parseFaceTemplate(template) {
  try {
    const signature = JSON.parse(template);
    return faceSignatureSchema.safeParse(signature).success ? signature : null;
  } catch {
    return null;
  }
}

function faceDistance(left, right) {
  const total = left.reduce((sum, value, index) => {
    const delta = value - right[index];
    return sum + delta * delta;
  }, 0);

  return Math.sqrt(total);
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    personId: user.personId,
    name: user.name || titleCase(user.role)
  };
}

function titleCase(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
