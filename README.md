# Attendance Desk

A small attendance app with an Express backend, SQLite database, and browser UI.

## Run

```bash
npm install
npm start
```

Open http://localhost:3000 in your browser.

## Demo Logins

- Student: `Aarav Sharma` / `Aarav Sharma123`
- Teacher: `Anita Rao` / `Anita Rao123`
- Principal: `principal` / `principal123`

For every student or teacher, the login ID is their full name and the password is their full name plus `123`.

## Roles

- Students can view only their own attendance.
- Teachers can add students with a standard and mark student attendance.
- The principal can add students with a standard, add teachers with a subject, and mark teacher attendance.

## Security And Data

- `helmet` adds hardened HTTP headers and a content security policy.
- `express-rate-limit` limits repeated API calls.
- `zod` validates request data before it reaches the database.
- SQLite stores people and attendance in `attendance.db`.
- Prepared statements are used for database writes and reads.
