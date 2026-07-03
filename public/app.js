const TOKEN_KEY = "attendance-token";

const state = {
  token: localStorage.getItem(TOKEN_KEY),
  user: null,
  selectedDate: today(),
  target: "students",
  people: [],
  cameraStream: null,
  cameraMode: null,
  cameraPersonId: null,
  summary: {
    present: 0,
    absent: 0,
    late: 0,
    total: 0
  }
};

const elements = {
  loginPanel: document.querySelector("#loginPanel"),
  appPanel: document.querySelector("#appPanel"),
  loginForm: document.querySelector("#loginForm"),
  username: document.querySelector("#username"),
  password: document.querySelector("#password"),
  logout: document.querySelector("#logoutButton"),
  roleLine: document.querySelector("#roleLine"),
  targetField: document.querySelector("#targetField"),
  target: document.querySelector("#targetSelect"),
  date: document.querySelector("#sessionDate"),
  form: document.querySelector("#addStudentForm"),
  name: document.querySelector("#studentName"),
  detail: document.querySelector("#personDetail"),
  detailHead: document.querySelector("#detailHead"),
  search: document.querySelector("#searchInput"),
  faceAttendance: document.querySelector("#faceAttendance"),
  facePanel: document.querySelector("#facePanel"),
  faceTitle: document.querySelector("#faceTitle"),
  cameraStatus: document.querySelector("#cameraStatus"),
  cameraVideo: document.querySelector("#cameraVideo"),
  faceCanvas: document.querySelector("#faceCanvas"),
  captureFace: document.querySelector("#captureFace"),
  closeCamera: document.querySelector("#closeCamera"),
  list: document.querySelector("#attendanceList"),
  empty: document.querySelector("#emptyState"),
  present: document.querySelector("#presentCount"),
  absent: document.querySelector("#absentCount"),
  late: document.querySelector("#lateCount"),
  total: document.querySelector("#totalCount"),
  markAllPresent: document.querySelector("#markAllPresent"),
  exportCsv: document.querySelector("#exportCsv")
};

elements.date.value = state.selectedDate;

elements.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const data = await publicApi("/api/login", {
    method: "POST",
    body: JSON.stringify({
      username: elements.username.value.trim(),
      password: elements.password.value
    })
  });

  state.token = data.token;
  state.user = data.user;
  localStorage.setItem(TOKEN_KEY, state.token);
  elements.password.value = "";
  configureForRole();
  await loadAttendance();
});

elements.logout.addEventListener("click", async () => {
  try {
    await api("/api/logout", { method: "POST" });
  } catch {
    // Local logout should still work if the token is already expired.
  }

  state.token = null;
  state.user = null;
  state.people = [];
  closeCamera();
  localStorage.removeItem(TOKEN_KEY);
  showLogin();
});

elements.target.addEventListener("change", async () => {
  state.target = elements.target.value;
  refreshPermissions();
  updateNamePlaceholder();
  await loadAttendance();
});

elements.date.addEventListener("change", async () => {
  state.selectedDate = elements.date.value || today();
  await loadAttendance();
});

elements.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = elements.name.value.trim();
  const detail = elements.detail.value.trim();

  if (!name || !detail || !canAddPeople()) return;

  await api("/api/people", {
    method: "POST",
    body: JSON.stringify({
      name,
      role: personRoleForTarget(),
      [detailKeyForTarget()]: detail
    })
  });

  elements.name.value = "";
  elements.detail.value = "";
  await loadAttendance();
});

elements.search.addEventListener("input", render);

elements.markAllPresent.addEventListener("click", async () => {
  if (!canMarkAttendance()) return;

  await api("/api/attendance/mark-all", {
    method: "POST",
    body: JSON.stringify({ date: state.selectedDate, target: state.target, status: "present" })
  });
  await loadAttendance();
});

elements.faceAttendance.addEventListener("click", async () => {
  if (!canMarkAttendance()) return;
  await openCamera("scan");
});

elements.captureFace.addEventListener("click", captureFace);
elements.closeCamera.addEventListener("click", closeCamera);

elements.exportCsv.addEventListener("click", exportCsv);

bootstrap();

async function bootstrap() {
  if (!state.token) {
    showLogin();
    return;
  }

  try {
    state.user = await api("/api/me");
    configureForRole();
    await loadAttendance();
  } catch {
    localStorage.removeItem(TOKEN_KEY);
    state.token = null;
    showLogin();
  }
}

function configureForRole() {
  const role = state.user.role;
  state.target = role === "principal" ? "teachers" : "students";
  elements.target.value = state.target;
  elements.loginPanel.classList.add("hidden");
  elements.appPanel.classList.remove("hidden");
  elements.roleLine.textContent = `${state.user.name} signed in as ${titleCase(role)}`;
  elements.targetField.classList.toggle("hidden", role !== "principal");
  updateNamePlaceholder();
  refreshPermissions();
}

function refreshPermissions() {
  elements.form.classList.toggle("hidden", !canAddPeople());
  elements.markAllPresent.disabled = !canMarkAttendance();
  elements.faceAttendance.disabled = !canMarkAttendance();
}

function updateNamePlaceholder() {
  elements.name.placeholder = state.target === "teachers" ? "Teacher name" : "Student name";
  elements.detail.placeholder = state.target === "teachers" ? "Subject" : "Standard";
  elements.detailHead.textContent = state.target === "teachers" ? "Subject" : "Standard";
}

function showLogin() {
  elements.loginPanel.classList.remove("hidden");
  elements.appPanel.classList.add("hidden");
  elements.username.focus();
}

async function loadAttendance() {
  const data = await api(`/api/attendance?date=${encodeURIComponent(state.selectedDate)}&target=${state.target}`);
  state.people = data.people;
  state.summary = data.summary;
  render();
}

function render() {
  const query = elements.search.value.trim().toLowerCase();
  const people = state.people.filter((person) => person.name.toLowerCase().includes(query));

  elements.list.innerHTML = "";
  elements.empty.textContent = canAddPeople() ? "Add a person to begin marking attendance." : "No attendance record found.";
  elements.empty.classList.toggle("hidden", people.length > 0);

  people.forEach((person) => {
    elements.list.append(createRow(person));
  });

  elements.present.textContent = state.summary.present;
  elements.absent.textContent = state.summary.absent;
  elements.late.textContent = state.summary.late;
  elements.total.textContent = state.summary.total;
}

function createRow(person) {
  const row = document.createElement("article");
  row.className = canMarkAttendance() ? "attendance-row" : "attendance-row view-only";

  const name = document.createElement("div");
  name.className = "person-name";
  name.textContent = person.name;

  const detail = document.createElement("div");
  detail.className = "person-detail";
  detail.textContent = personDetail(person);

  const statusGroup = document.createElement("div");
  statusGroup.className = "status-group";
  statusGroup.setAttribute("role", "radiogroup");
  statusGroup.setAttribute("aria-label", `${person.name} attendance status`);

  ["present", "absent", "late"].forEach((status) => {
    const label = document.createElement("label");
    label.className = `status-option ${status}`;

    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = `status-${person.id}`;
    radio.value = status;
    radio.checked = person.status === status;
    radio.disabled = !canMarkAttendance();
    radio.addEventListener("change", async () => {
      await saveAttendance(person.id, { status });
      await loadAttendance();
    });

    const text = document.createElement("span");
    text.textContent = titleCase(status);

    label.append(radio, text);
    statusGroup.append(label);
  });

  const note = document.createElement("textarea");
  note.placeholder = "Optional note";
  note.value = person.note || "";
  note.disabled = !canMarkAttendance();
  note.addEventListener("change", async () => {
    await saveAttendance(person.id, { note: note.value });
    await loadAttendance();
  });

  row.append(name, detail, statusGroup, note);

  if (canAddPeople()) {
    const actions = document.createElement("div");
    actions.className = "row-actions";

    const enroll = document.createElement("button");
    enroll.type = "button";
    enroll.className = "ghost";
    enroll.textContent = person.faceEnrolled ? "Update face" : "Enroll face";
    enroll.addEventListener("click", async () => {
      await openCamera("enroll", person);
    });

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "danger";
    remove.textContent = "Delete";
    remove.addEventListener("click", async () => {
      await api(`/api/people/${person.id}`, { method: "DELETE" });
      await loadAttendance();
    });

    actions.append(enroll, remove);
    row.append(actions);
  }

  return row;
}

async function openCamera(mode, person = null) {
  if (!navigator.mediaDevices?.getUserMedia) {
    alert("Camera access is not available in this browser.");
    return;
  }

  closeCamera(false);

  state.cameraMode = mode;
  state.cameraPersonId = person?.id || null;
  elements.faceTitle.textContent = mode === "enroll" ? `Enroll ${person.name}` : "Face attendance";
  elements.cameraStatus.textContent = "Starting camera...";
  elements.facePanel.classList.remove("hidden");

  try {
    state.cameraStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: "user",
        width: { ideal: 640 },
        height: { ideal: 360 }
      }
    });
    elements.cameraVideo.srcObject = state.cameraStream;
    await elements.cameraVideo.play();
    elements.cameraStatus.textContent = mode === "enroll"
      ? "Look at the camera and capture this person."
      : "Look at the camera and capture to mark present.";
  } catch (error) {
    closeCamera();
    alert("Allow camera permission to use face attendance.");
  }
}

function closeCamera(hidePanel = true) {
  if (state.cameraStream) {
    state.cameraStream.getTracks().forEach((track) => track.stop());
  }

  state.cameraStream = null;
  state.cameraMode = null;
  state.cameraPersonId = null;
  elements.cameraVideo.srcObject = null;
  elements.cameraStatus.textContent = "Camera is off.";

  if (hidePanel) {
    elements.facePanel.classList.add("hidden");
  }
}

async function captureFace() {
  if (!state.cameraStream) return;

  elements.captureFace.disabled = true;
  elements.cameraStatus.textContent = "Reading face...";

  try {
    const signature = await createFaceSignature();

    if (state.cameraMode === "enroll") {
      await api(`/api/people/${state.cameraPersonId}/face`, {
        method: "PATCH",
        body: JSON.stringify({ target: state.target, signature })
      });
      elements.cameraStatus.textContent = "Face enrolled.";
      closeCamera();
      await loadAttendance();
      return;
    }

    const result = await api("/api/attendance/face", {
      method: "POST",
      body: JSON.stringify({
        date: state.selectedDate,
        target: state.target,
        signature
      })
    });
    elements.cameraStatus.textContent = `${result.person.name} marked present.`;
    await loadAttendance();
  } catch (error) {
    elements.cameraStatus.textContent = error.message;
  } finally {
    elements.captureFace.disabled = false;
  }
}

async function createFaceSignature() {
  const video = elements.cameraVideo;

  if (!video.videoWidth || !video.videoHeight) {
    throw new Error("Camera is not ready yet.");
  }

  const bounds = await detectFaceBounds(video);
  const crop = bounds || centerCrop(video.videoWidth, video.videoHeight);
  const canvas = elements.faceCanvas;
  canvas.width = 8;
  canvas.height = 8;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(video, crop.x, crop.y, crop.width, crop.height, 0, 0, 8, 8);

  const pixels = context.getImageData(0, 0, 8, 8).data;
  const values = [];

  for (let index = 0; index < pixels.length; index += 4) {
    values.push(((pixels[index] * 0.299) + (pixels[index + 1] * 0.587) + (pixels[index + 2] * 0.114)) / 255);
  }

  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const centered = values.map((value) => value - mean);
  const norm = Math.hypot(...centered) || 1;

  return centered.map((value) => Number((value / norm).toFixed(4)));
}

async function detectFaceBounds(video) {
  if (!("FaceDetector" in window)) {
    return null;
  }

  try {
    const detector = new FaceDetector({ fastMode: true, maxDetectedFaces: 1 });
    const faces = await detector.detect(video);

    if (!faces.length) {
      return null;
    }

    const box = faces[0].boundingBox;
    const padding = Math.max(box.width, box.height) * 0.25;
    return clampCrop({
      x: box.x - padding,
      y: box.y - padding,
      width: box.width + padding * 2,
      height: box.height + padding * 2
    }, video.videoWidth, video.videoHeight);
  } catch {
    return null;
  }
}

function centerCrop(width, height) {
  const size = Math.min(width, height) * 0.72;
  return {
    x: (width - size) / 2,
    y: (height - size) / 2,
    width: size,
    height: size
  };
}

function clampCrop(crop, width, height) {
  const size = Math.min(Math.max(crop.width, crop.height), width, height);
  return {
    x: Math.max(0, Math.min(width - size, crop.x + (crop.width - size) / 2)),
    y: Math.max(0, Math.min(height - size, crop.y + (crop.height - size) / 2)),
    width: size,
    height: size
  };
}

async function saveAttendance(personId, updates) {
  await api(`/api/attendance/${personId}`, {
    method: "PATCH",
    body: JSON.stringify({
      date: state.selectedDate,
      target: state.target,
      ...updates
    })
  });
}

function exportCsv() {
  const rows = [["Date", "Register", "Name", detailLabelForTarget(), "Status", "Note"]];

  state.people.forEach((person) => {
    rows.push([
      state.selectedDate,
      titleCase(state.target),
      person.name,
      personDetail(person),
      titleCase(person.status),
      person.note || ""
    ]);
  });

  const csv = rows.map((row) => row.map(csvCell).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `attendance-${state.target}-${state.selectedDate}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function canMarkAttendance() {
  return (state.user?.role === "teacher" && state.target === "students") || (state.user?.role === "principal" && state.target === "teachers");
}

function canAddPeople() {
  return (state.user?.role === "teacher" && state.target === "students") || state.user?.role === "principal";
}

function personRoleForTarget() {
  return state.target === "teachers" ? "teacher" : "student";
}

function detailKeyForTarget() {
  return state.target === "teachers" ? "subject" : "standard";
}

function detailLabelForTarget() {
  return state.target === "teachers" ? "Subject" : "Standard";
}

function personDetail(person) {
  return state.target === "teachers" ? person.subject || "" : person.standard || "";
}

async function api(url, options = {}) {
  return publicApi(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${state.token}`,
      ...options.headers
    }
  });
}

async function publicApi(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options.headers
    }
  });

  if (!response.ok) {
    const message = await readError(response);
    alert(message);
    throw new Error(message);
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

async function readError(response) {
  try {
    const data = await response.json();
    return data.error || "Something went wrong.";
  } catch {
    return "Something went wrong.";
  }
}

function csvCell(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function today() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function titleCase(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
