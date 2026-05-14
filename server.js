const WebSocket = require("ws");
const http = require("http");

const server = http.createServer();
const wss = new WebSocket.WebSocketServer({ server });

server.listen(process.env.PORT || 8080, () => {
  console.log("Server running...");
});
// ── STATE ──
const students = new Map();      // id -> student object
const teachers = new Set();
const chatHistory = [];          // max 200
const sessionLogs = new Map();   // studentId -> log[]
const pinnedMessages = [];       // max 5
const announcements = [];     
const polls = new Map();
const quizzes = new Map();
const breakoutRooms = new Map(); // roomId -> { name, studentIds, chatHistory }
const sharedFiles = [];          // max 50 files
const whiteboardStrokes = [];    // persistent strokes
const annotations = new Map();   // studentId -> annotations[]
const attentionScores = new Map(); // studentId -> { score, lastActivity }
const remoteControlSessions = new Map(); // studentId -> { active, teacherWs }
const timerState = { active: false, remaining: 0, total: 0, label: "" };
let timerInterval = null;

let classroomLocked = false;
let spotlightStudentId = null;
let handQueue = []; // ordered list of studentIds who raised hands
let adminConfig = {
  allowStudentChat: true,
  allowStudentReactions: true,
  allowStudentCamera: true,
  allowStudentScreen: true,
  screenRecordEnabled: true,
  maxStudents: 60,
  allowStudentAnnotate: true,
  allowStudentWhiteboard: false,
  attentionTracking: true,
};
let sessionStartTime = Date.now();
let totalJoined = 0;

// ── HELPERS ──
function broadcast(data, targets) {
  const msg = typeof data === "string" ? data : JSON.stringify(data);
  for (const ws of targets) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(msg); } catch (_) {}
    }
  }
}

function getAllWS() {
  return [...teachers, ...Array.from(students.values()).map(s => s.ws)];
}

function getStudentList() {
  return Array.from(students.values()).map(s => ({
    id: s.id, username: s.username, class: s.class, avatar: s.avatar,
    handRaised: s.handRaised, status: s.status, joinedAt: s.joinedAt,
    muted: s.muted, cameraOff: s.cameraOff, frozen: s.frozen || false,
    breakoutRoom: s.breakoutRoom || null,
    attentionScore: attentionScores.get(s.id)?.score || 100,
    remoteControlled: remoteControlSessions.get(s.id)?.active || false,
  }));
}

function logActivity(studentId, action, detail = "") {
  const entry = { timestamp: Date.now(), action, detail };
  if (!sessionLogs.has(studentId)) sessionLogs.set(studentId, []);
  const log = sessionLogs.get(studentId);
  log.push(entry);
  if (log.length > 500) log.shift();
  // Update attention score on activity
  updateAttentionScore(studentId, action);
}

function genId(len = 8) {
  return crypto.randomBytes(len).toString("hex");
}

// ── ATTENTION SCORING ──
function updateAttentionScore(studentId, action) {
  if (!adminConfig.attentionTracking) return;
  if (!attentionScores.has(studentId)) {
    attentionScores.set(studentId, { score: 100, lastActivity: Date.now() });
  }
  const a = attentionScores.get(studentId);
  a.lastActivity = Date.now();
  // Boost score for positive actions
  const boostActions = ["CHAT", "POLL_ANSWER", "HAND_UP", "STATUS"];
  const boostAmt = boostActions.includes(action) ? 5 : 1;
  a.score = Math.min(100, a.score + boostAmt);
  attentionScores.set(studentId, a);
}

// Decay attention scores every 30s for inactive students
setInterval(() => {
  const now = Date.now();
  students.forEach((s, sid) => {
    if (!attentionScores.has(sid)) attentionScores.set(sid, { score: 100, lastActivity: now });
    const a = attentionScores.get(sid);
    const idleMs = now - a.lastActivity;
    if (idleMs > 60000) { // inactive > 1min
      a.score = Math.max(0, a.score - 10);
      attentionScores.set(sid, a);
      broadcast({ type: "ATTENTION_UPDATE", studentId: sid, score: a.score }, teachers);
    }
  });
}, 30000);

// ── HEARTBEAT ──
const interval = setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);
wss.on("close", () => clearInterval(interval));

// ── CONNECTION ──
wss.on("connection", (ws, req) => {
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  const params = url.parse(req.url, true).query;
  ws.role = params.role === "teacher" ? "teacher" : "student";

  // ── STUDENT ──
  if (ws.role === "student") {
    if (!params.username || !params.class) { ws.close(1008, "Missing fields"); return; }
    if (classroomLocked) { ws.send(JSON.stringify({ type: "KICKED", reason: "Classroom is currently locked." })); ws.close(); return; }
    if (students.size >= adminConfig.maxStudents) { ws.send(JSON.stringify({ type: "KICKED", reason: "Classroom is full." })); ws.close(); return; }

    ws.studentId = genId(6);
    ws.username = decodeURIComponent(params.username).slice(0, 60);
    ws.class = decodeURIComponent(params.class).slice(0, 80);
    ws.avatar = params.avatar ? decodeURIComponent(params.avatar) : "👤";
    ws.handRaised = false;
    ws.status = "active";
    ws.muted = false;
    ws.cameraOff = false;
    ws.frozen = false;
    ws.joinedAt = Date.now();
    ws.breakoutRoom = null;
    totalJoined++;

    const s = {
      id: ws.studentId, username: ws.username, class: ws.class, avatar: ws.avatar,
      handRaised: false, status: "active", muted: false, cameraOff: false, frozen: false,
      ws, joinedAt: ws.joinedAt, breakoutRoom: null,
    };
    students.set(ws.studentId, s);
    attentionScores.set(ws.studentId, { score: 100, lastActivity: Date.now() });
    logActivity(ws.studentId, "JOIN", `class:${ws.class}`);

    // Send initial state to student
    ws.send(JSON.stringify({ type: "INFO", data: { id: ws.studentId, username: ws.username, class: ws.class, adminConfig } }));
    ws.send(JSON.stringify({ type: "CHAT_HISTORY", data: chatHistory.slice(-60) }));
    if (pinnedMessages.length) ws.send(JSON.stringify({ type: "PINNED_MESSAGES", data: pinnedMessages }));
    if (classroomLocked) ws.send(JSON.stringify({ type: "CLASS_LOCKED" }));
    if (whiteboardStrokes.length) ws.send(JSON.stringify({ type: "WHITEBOARD_INIT", data: whiteboardStrokes }));
    if (timerState.active) ws.send(JSON.stringify({ type: "TIMER_UPDATE", data: timerState }));
    // Send shared files list
    if (sharedFiles.length) ws.send(JSON.stringify({ type: "FILES_LIST", data: sharedFiles.map(f => ({ id: f.id, name: f.name, size: f.size, type: f.type, sharedBy: f.sharedBy, timestamp: f.timestamp })) }));
    // Send active polls
    for (const poll of polls.values()) {
      if (poll.active) ws.send(JSON.stringify({ type: "POLL_CREATE", data: poll }));
    }

    // Notify teachers
    broadcast({ type: "NEW_STUDENT", data: { id: ws.studentId, username: ws.username, class: ws.class, avatar: ws.avatar, handRaised: false, status: "active", joinedAt: s.joinedAt } }, teachers);
    broadcast({ type: "SYSTEM_NOTIFY", message: `${ws.username} joined (${ws.class})`, kind: "join" }, teachers);
    broadcastSessionStats();

  // ── TEACHER ──
  } else if (ws.role === "teacher") {
    teachers.add(ws);
    ws.send(JSON.stringify({ type: "ACTIVE_LIST", data: getStudentList() }));
    ws.send(JSON.stringify({ type: "CHAT_HISTORY", data: chatHistory.slice(-80) }));
    ws.send(JSON.stringify({ type: "PINNED_MESSAGES", data: pinnedMessages }));
    ws.send(JSON.stringify({ type: "POLLS_STATE", data: Array.from(polls.values()) }));
    ws.send(JSON.stringify({ type: "ADMIN_CONFIG", data: adminConfig }));
    ws.send(JSON.stringify({ type: "SESSION_STATS", data: getSessionStats() }));
    ws.send(JSON.stringify({ type: "WHITEBOARD_INIT", data: whiteboardStrokes }));
    ws.send(JSON.stringify({ type: "BREAKOUT_ROOMS", data: Array.from(breakoutRooms.values()) }));
    ws.send(JSON.stringify({ type: "FILES_LIST", data: sharedFiles.map(f => ({ id: f.id, name: f.name, size: f.size, type: f.type, sharedBy: f.sharedBy, timestamp: f.timestamp })) }));
    ws.send(JSON.stringify({ type: "HAND_QUEUE", data: handQueue }));
    if (spotlightStudentId) ws.send(JSON.stringify({ type: "SPOTLIGHT", studentId: spotlightStudentId }));
    if (timerState.active) ws.send(JSON.stringify({ type: "TIMER_UPDATE", data: timerState }));

    ws.on("close", () => {
      teachers.delete(ws);
      // End any remote control sessions owned by this teacher
      remoteControlSessions.forEach((session, sid) => {
        if (session.teacherWs === ws) {
          session.active = false;
          const s = students.get(sid);
          if (s) s.ws.send(JSON.stringify({ type: "REMOTE_CONTROL_END" }));
          remoteControlSessions.delete(sid);
        }
      });
    });
  } else {
    ws.close();
    return;
  }

  // ── MESSAGES ──
  ws.on("message", (rawData) => {
    let parsed = null;
    try {
      if (typeof rawData === "string") parsed = JSON.parse(rawData);
      else if (rawData instanceof Buffer && rawData.length > 0 && rawData[0] === 123)
        parsed = JSON.parse(rawData.toString());
    } catch (_) {}

    if (parsed) {
      handleTextMessage(ws, parsed);
      return;
    }

    // Binary media
    if (rawData instanceof Buffer && rawData.length > 0) {
      handleBinaryMedia(ws, rawData);
    }
  });

  ws.on("close", () => {
    if (ws.role === "student") {
      logActivity(ws.studentId, "LEAVE");
      students.delete(ws.studentId);
      attentionScores.delete(ws.studentId);
      remoteControlSessions.delete(ws.studentId);
      // Remove from hand queue
      handQueue = handQueue.filter(id => id !== ws.studentId);
      broadcast({ type: "HAND_QUEUE", data: handQueue }, teachers);

      if (spotlightStudentId === ws.studentId) {
        spotlightStudentId = null;
        broadcast({ type: "CLEAR_SPOTLIGHT" }, [...teachers]);
      }
      // Remove from breakout rooms
      breakoutRooms.forEach(room => {
        const idx = room.studentIds.indexOf(ws.studentId);
        if (idx !== -1) room.studentIds.splice(idx, 1);
      });
      broadcast({ type: "DISCONNECT", data: { id: ws.studentId } }, getAllWS());
      broadcast({ type: "SYSTEM_NOTIFY", message: `${ws.username} left the session`, kind: "leave" }, teachers);
      broadcastSessionStats();
    }
  });

  ws.on("error", () => {});
});

// ── TEXT MESSAGE HANDLER ──
function handleTextMessage(ws, msg) {

  // ── TEACHER COMMANDS ──
  if (ws.role === "teacher") {
    switch (msg.type) {

      case "AUDIO_BROADCAST":
        msg.targetStudentIds.forEach(sid => {
          const s = students.get(sid);
          if (s && s.ws.readyState === WebSocket.OPEN)
            s.ws.send(JSON.stringify({ type: "TEACHER_AUDIO", data: msg.audioData }));
        });
        break;

      case "KICK_STUDENT": {
        const s = students.get(msg.studentId);
        if (s) {
          s.ws.send(JSON.stringify({ type: "KICKED", reason: msg.reason || "Removed by teacher" }));
          setTimeout(() => s.ws.close(), 200);
        }
        break;
      }

      case "MUTE_STUDENT": {
        const s = students.get(msg.studentId);
        if (s) {
          s.muted = true;
          s.ws.send(JSON.stringify({ type: "FORCE_MUTE" }));
          broadcast({ type: "STUDENT_MUTED", studentId: msg.studentId, muted: true }, teachers);
          logActivity(msg.studentId, "MUTED_BY_TEACHER");
        }
        break;
      }

      case "UNMUTE_STUDENT": {
        const s = students.get(msg.studentId);
        if (s) {
          s.muted = false;
          s.ws.send(JSON.stringify({ type: "FORCE_UNMUTE" }));
          broadcast({ type: "STUDENT_MUTED", studentId: msg.studentId, muted: false }, teachers);
        }
        break;
      }

      case "MUTE_ALL":
        students.forEach((s, sid) => {
          s.muted = true;
          s.ws.send(JSON.stringify({ type: "FORCE_MUTE" }));
          broadcast({ type: "STUDENT_MUTED", studentId: sid, muted: true }, teachers);
        });
        break;

      case "UNMUTE_ALL":
        students.forEach((s, sid) => {
          s.muted = false;
          s.ws.send(JSON.stringify({ type: "FORCE_UNMUTE" }));
          broadcast({ type: "STUDENT_MUTED", studentId: sid, muted: false }, teachers);
        });
        break;

      case "FREEZE_SCREEN": {
        const s = students.get(msg.studentId);
        if (s) {
          s.frozen = msg.frozen;
          s.ws.send(JSON.stringify({ type: "FREEZE_SCREEN", frozen: msg.frozen }));
          broadcast({ type: "SCREEN_FROZEN", studentId: msg.studentId, frozen: msg.frozen }, teachers);
        }
        break;
      }

      case "SPOTLIGHT":
        spotlightStudentId = msg.studentId;
        broadcast({ type: "SPOTLIGHT", studentId: msg.studentId }, [...teachers]);
        break;

      case "CLEAR_SPOTLIGHT":
        spotlightStudentId = null;
        broadcast({ type: "CLEAR_SPOTLIGHT" }, [...teachers]);
        break;

      case "LOCK_CLASSROOM":
        classroomLocked = msg.locked;
        broadcast({ type: classroomLocked ? "CLASS_LOCKED" : "CLASS_UNLOCKED" }, getAllWS());
        break;

      case "PIN_MESSAGE": {
        const m = chatHistory.find(m => m.id === msg.messageId);
        if (m && !pinnedMessages.find(p => p.id === m.id)) {
          pinnedMessages.push({ ...m, pinnedAt: Date.now() });
          if (pinnedMessages.length > 5) pinnedMessages.shift();
          broadcast({ type: "PINNED_MESSAGES", data: pinnedMessages }, getAllWS());
        }
        break;
      }

      case "UNPIN_MESSAGE": {
        const idx = pinnedMessages.findIndex(m => m.id === msg.messageId);
        if (idx !== -1) { pinnedMessages.splice(idx, 1); broadcast({ type: "PINNED_MESSAGES", data: pinnedMessages }, getAllWS()); }
        break;
      }

      case "ANNOUNCEMENT": {
        const ann = { id: genId(4), text: msg.text, timestamp: Date.now() };
        announcements.push(ann);
        broadcast({ type: "ANNOUNCEMENT", data: ann }, getAllWS());
        break;
      }

      case "DELETE_MESSAGE": {
        const idx = chatHistory.findIndex(m => m.id === msg.messageId);
        if (idx !== -1) chatHistory.splice(idx, 1);
        broadcast({ type: "MESSAGE_DELETED", messageId: msg.messageId }, getAllWS());
        break;
      }

      case "POLL_CREATE": {
        const poll = {
          ...msg.data,
          id: genId(4),
          created: Date.now(),
          answers: {},
          active: true,
          correctAnswer: msg.data.correctAnswer || null,
        };
        polls.set(poll.id, poll);
        broadcast({ type: "POLL_CREATE", data: poll }, getAllWS());
        break;
      }

      case "POLL_CLOSE": {
        const poll = polls.get(msg.pollId);
        if (poll) {
          poll.active = false;
          broadcast({ type: "POLL_CLOSED", pollId: msg.pollId, results: poll.answers }, getAllWS());
        }
        break;
      }

      case "DISMISS_HAND": {
        const s = students.get(msg.studentId);
        if (s) {
          s.handRaised = false;
          handQueue = handQueue.filter(id => id !== msg.studentId);
          broadcast({ type: "HAND_RAISE", studentId: msg.studentId, raised: false, username: s.username }, getAllWS());
          broadcast({ type: "HAND_QUEUE", data: handQueue }, teachers);
        }
        break;
      }

      case "CALL_ON_STUDENT": {
        const s = students.get(msg.studentId);
        if (s) {
          s.ws.send(JSON.stringify({ type: "CALLED_ON" }));
          broadcast({ type: "STUDENT_CALLED", studentId: msg.studentId, username: s.username }, teachers);
        }
        break;
      }

      case "UPDATE_ADMIN_CONFIG":
        Object.assign(adminConfig, msg.config);
        broadcast({ type: "ADMIN_CONFIG", data: adminConfig }, getAllWS());
        break;

      case "GET_SESSION_LOG":
        ws.send(JSON.stringify({ type: "SESSION_LOG", studentId: msg.studentId, data: sessionLogs.get(msg.studentId) || [] }));
        break;

      case "QUIZ_CREATE": {
        const quiz = { ...msg.data, id: genId(4), created: Date.now(), active: true, answers: {} };
        quizzes.set(quiz.id, quiz);
        broadcast({ type: "QUIZ_CREATE", data: quiz }, getAllWS());
        break;
      }

      case "GET_SESSION_STATS":
        ws.send(JSON.stringify({ type: "SESSION_STATS", data: getSessionStats() }));
        break;

      case "SEND_PRIVATE_MSG": {
        const s = students.get(msg.studentId);
        if (s) s.ws.send(JSON.stringify({ type: "PRIVATE_MSG", text: msg.text, from: "Teacher" }));
        break;
      }

      // ── NEW: REMOTE MOUSE/KEYBOARD CONTROL ──
      case "REMOTE_CONTROL_START": {
        const s = students.get(msg.studentId);
        if (s) {
          remoteControlSessions.set(msg.studentId, { active: true, teacherWs: ws });
          s.ws.send(JSON.stringify({ type: "REMOTE_CONTROL_START", teacherId: "teacher" }));
          broadcast({ type: "REMOTE_CONTROL_STATUS", studentId: msg.studentId, active: true }, teachers);
          logActivity(msg.studentId, "REMOTE_CONTROL_START");
        }
        break;
      }

      case "REMOTE_CONTROL_END": {
        const s = students.get(msg.studentId);
        if (s) {
          remoteControlSessions.delete(msg.studentId);
          s.ws.send(JSON.stringify({ type: "REMOTE_CONTROL_END" }));
          broadcast({ type: "REMOTE_CONTROL_STATUS", studentId: msg.studentId, active: false }, teachers);
          logActivity(msg.studentId, "REMOTE_CONTROL_END");
        }
        break;
      }

      // Teacher sends mouse/keyboard events to student
      case "REMOTE_INPUT": {
        const s = students.get(msg.studentId);
        const session = remoteControlSessions.get(msg.studentId);
        if (s && session && session.active) {
          s.ws.send(JSON.stringify({ type: "REMOTE_INPUT", event: msg.event }));
        }
        break;
      }

      // ── NEW: WHITEBOARD ──
      case "WHITEBOARD_STROKE": {
        const stroke = { ...msg.stroke, id: genId(4), timestamp: Date.now(), author: "teacher" };
        whiteboardStrokes.push(stroke);
        if (whiteboardStrokes.length > 2000) whiteboardStrokes.shift();
        broadcast({ type: "WHITEBOARD_STROKE", stroke }, getAllWS());
        break;
      }

      case "WHITEBOARD_CLEAR":
        whiteboardStrokes.length = 0;
        broadcast({ type: "WHITEBOARD_CLEAR" }, getAllWS());
        break;

      case "WHITEBOARD_UNDO": {
        // Remove last teacher stroke
        for (let i = whiteboardStrokes.length - 1; i >= 0; i--) {
          if (whiteboardStrokes[i].author === "teacher") {
            whiteboardStrokes.splice(i, 1);
            break;
          }
        }
        broadcast({ type: "WHITEBOARD_INIT", data: whiteboardStrokes }, getAllWS());
        break;
      }

      // ── NEW: SCREEN ANNOTATIONS ──
      case "ANNOTATION_ADD": {
        const ann = { ...msg.annotation, id: genId(4), author: "teacher", timestamp: Date.now() };
        if (!annotations.has("teacher")) annotations.set("teacher", []);
        annotations.get("teacher").push(ann);
        broadcast({ type: "ANNOTATION_ADD", annotation: ann }, getAllWS());
        break;
      }

      case "ANNOTATION_CLEAR":
        annotations.delete("teacher");
        if (msg.studentId) annotations.delete(msg.studentId);
        broadcast({ type: "ANNOTATION_CLEAR", target: msg.target || "all" }, getAllWS());
        break;

      // ── NEW: BREAKOUT ROOMS ──
      case "BREAKOUT_CREATE": {
        const room = {
          id: genId(4),
          name: msg.name || `Room ${breakoutRooms.size + 1}`,
          studentIds: [],
          chatHistory: [],
          created: Date.now(),
        };
        breakoutRooms.set(room.id, room);
        broadcast({ type: "BREAKOUT_ROOMS", data: Array.from(breakoutRooms.values()) }, teachers);
        break;
      }

      case "BREAKOUT_ASSIGN": {
        // Assign student to a room
        const room = breakoutRooms.get(msg.roomId);
        const s = students.get(msg.studentId);
        if (room && s) {
          // Remove from old room
          breakoutRooms.forEach(r => { const i = r.studentIds.indexOf(msg.studentId); if (i !== -1) r.studentIds.splice(i, 1); });
          room.studentIds.push(msg.studentId);
          s.breakoutRoom = msg.roomId;
          s.ws.send(JSON.stringify({ type: "BREAKOUT_ASSIGNED", roomId: msg.roomId, roomName: room.name }));
          broadcast({ type: "BREAKOUT_ROOMS", data: Array.from(breakoutRooms.values()) }, teachers);
        }
        break;
      }

      case "BREAKOUT_REMOVE": {
        const s = students.get(msg.studentId);
        if (s) {
          breakoutRooms.forEach(r => { const i = r.studentIds.indexOf(msg.studentId); if (i !== -1) r.studentIds.splice(i, 1); });
          s.breakoutRoom = null;
          s.ws.send(JSON.stringify({ type: "BREAKOUT_REMOVED" }));
          broadcast({ type: "BREAKOUT_ROOMS", data: Array.from(breakoutRooms.values()) }, teachers);
        }
        break;
      }

      case "BREAKOUT_DELETE": {
        const room = breakoutRooms.get(msg.roomId);
        if (room) {
          room.studentIds.forEach(sid => {
            const s = students.get(sid);
            if (s) { s.breakoutRoom = null; s.ws.send(JSON.stringify({ type: "BREAKOUT_REMOVED" })); }
          });
          breakoutRooms.delete(msg.roomId);
          broadcast({ type: "BREAKOUT_ROOMS", data: Array.from(breakoutRooms.values()) }, teachers);
        }
        break;
      }

      case "BREAKOUT_BROADCAST": {
        // Teacher message to a specific room
        const room = breakoutRooms.get(msg.roomId);
        if (room) {
          const entry = { id: genId(4), text: msg.text, sender: "Teacher", role: "teacher", timestamp: Date.now(), roomId: msg.roomId };
          room.chatHistory.push(entry);
          room.studentIds.forEach(sid => {
            const s = students.get(sid);
            if (s) s.ws.send(JSON.stringify({ type: "BREAKOUT_MSG", data: entry }));
          });
        }
        break;
      }

      case "BREAKOUT_CALL_BACK":
        // Return all students from breakout rooms to main session
        breakoutRooms.forEach(room => {
          room.studentIds.forEach(sid => {
            const s = students.get(sid);
            if (s) { s.breakoutRoom = null; s.ws.send(JSON.stringify({ type: "BREAKOUT_REMOVED", reason: "called_back" })); }
          });
          room.studentIds = [];
        });
        broadcast({ type: "BREAKOUT_ROOMS", data: Array.from(breakoutRooms.values()) }, teachers);
        broadcast({ type: "SYSTEM_NOTIFY", message: "All students called back from breakout rooms", kind: "info" }, teachers);
        break;

      // ── NEW: TIMER / COUNTDOWN ──
      case "TIMER_START": {
        if (timerInterval) clearInterval(timerInterval);
        timerState.active = true;
        timerState.total = msg.seconds;
        timerState.remaining = msg.seconds;
        timerState.label = msg.label || "Timer";
        broadcast({ type: "TIMER_UPDATE", data: { ...timerState } }, getAllWS());
        timerInterval = setInterval(() => {
          timerState.remaining--;
          broadcast({ type: "TIMER_UPDATE", data: { ...timerState } }, getAllWS());
          if (timerState.remaining <= 0) {
            timerState.active = false;
            clearInterval(timerInterval);
            timerInterval = null;
            broadcast({ type: "TIMER_END", label: timerState.label }, getAllWS());
          }
        }, 1000);
        break;
      }

      case "TIMER_STOP":
        if (timerInterval) clearInterval(timerInterval);
        timerInterval = null;
        timerState.active = false;
        broadcast({ type: "TIMER_UPDATE", data: { ...timerState } }, getAllWS());
        break;

      // ── NEW: FILE SHARE ──
      case "FILE_SHARE": {
        // msg.file: { name, type, size, dataUrl }
        const file = {
          id: genId(4),
          name: msg.file.name,
          type: msg.file.type,
          size: msg.file.size,
          dataUrl: msg.file.dataUrl,
          sharedBy: "teacher",
          timestamp: Date.now(),
        };
        sharedFiles.push(file);
        if (sharedFiles.length > 50) sharedFiles.shift();
        // Send metadata to all, data only on request
        broadcast({ type: "FILE_SHARED", file: { id: file.id, name: file.name, size: file.size, type: file.type, sharedBy: file.sharedBy, timestamp: file.timestamp } }, getAllWS());
        break;
      }

      case "FILE_REQUEST": {
        // Student requested a file
        const file = sharedFiles.find(f => f.id === msg.fileId);
        if (file) ws.send(JSON.stringify({ type: "FILE_DATA", file }));
        break;
      }

      case "FILE_DELETE": {
        const idx = sharedFiles.findIndex(f => f.id === msg.fileId);
        if (idx !== -1) sharedFiles.splice(idx, 1);
        broadcast({ type: "FILE_DELETED", fileId: msg.fileId }, getAllWS());
        break;
      }

      // ── NEW: ATTENTION / FOCUS CHECK ──
      case "FOCUS_CHECK": {
        // Send a focus check prompt to all or selected students
        const targets = msg.studentIds ? msg.studentIds.map(sid => students.get(sid)).filter(Boolean).map(s => s.ws) : [...students.values()].map(s => s.ws);
        broadcast({ type: "FOCUS_CHECK", question: msg.question || "Are you following along? Respond to let your teacher know.", checkId: genId(4) }, targets);
        break;
      }

      case "GET_ATTENTION_SCORES":
        ws.send(JSON.stringify({
          type: "ATTENTION_SCORES",
          data: Array.from(attentionScores.entries()).map(([sid, a]) => {
            const s = students.get(sid);
            return { studentId: sid, username: s?.username, score: a.score, lastActivity: a.lastActivity };
          })
        }));
        break;

      // ── NEW: SCREEN REGION HIGHLIGHT ──
      case "HIGHLIGHT_REGION": {
        // Teacher highlights a region on the screen for all students
        broadcast({ type: "HIGHLIGHT_REGION", region: msg.region, color: msg.color || "#ff0000", duration: msg.duration || 3000 }, [...students.values()].map(s => s.ws));
        break;
      }

      // ── NEW: PRIVATE ROOM CHAT (student-to-teacher) ──
      case "PRIVATE_REPLY": {
        const s = students.get(msg.studentId);
        if (s) s.ws.send(JSON.stringify({ type: "PRIVATE_MSG", text: msg.text, from: "Teacher" }));
        break;
      }

      // ── NEW: STUDENT SCREEN RECORDING TRIGGER ──
      case "REQUEST_RECORDING": {
        const s = students.get(msg.studentId);
        if (s) s.ws.send(JSON.stringify({ type: "START_RECORDING" }));
        break;
      }

      // ── NEW: SPEED QUIZ ──
      case "SPEED_QUIZ": {
        const quiz = {
          id: genId(4),
          question: msg.question,
          timeLimit: msg.timeLimit || 30,
          created: Date.now(),
          active: true,
          responses: {},
        };
        quizzes.set(quiz.id, quiz);
        broadcast({ type: "SPEED_QUIZ", data: quiz }, getAllWS());
        // Auto-close after timeLimit
        setTimeout(() => {
          quiz.active = false;
          broadcast({ type: "SPEED_QUIZ_END", quizId: quiz.id, responses: quiz.responses }, teachers);
        }, quiz.timeLimit * 1000);
        break;
      }

      // ── NEW: LASER POINTER ──
      case "LASER_POINTER": {
        // Broadcast laser pointer position to all students
        broadcast({ type: "LASER_POINTER", x: msg.x, y: msg.y, active: msg.active }, [...students.values()].map(s => s.ws));
        break;
      }

      // ── NEW: STUDENT GROUPING ──
      case "SET_STUDENT_TAG": {
        const s = students.get(msg.studentId);
        if (s) {
          s.tag = msg.tag;
          broadcast({ type: "STUDENT_TAG", studentId: msg.studentId, tag: msg.tag }, teachers);
        }
        break;
      }
    }
  }

  // ── STUDENT ACTIONS ──
  if (ws.role === "student") {
    switch (msg.type) {
      case "HAND_RAISE": {
        const s = students.get(ws.studentId);
        if (s) {
          s.handRaised = msg.raised;
          s.raisedAt = msg.raised ? Date.now() : null;
          if (msg.raised && !handQueue.includes(ws.studentId)) {
            handQueue.push(ws.studentId);
          } else if (!msg.raised) {
            handQueue = handQueue.filter(id => id !== ws.studentId);
          }
          logActivity(ws.studentId, msg.raised ? "HAND_UP" : "HAND_DOWN");
          broadcast({ type: "HAND_RAISE", studentId: ws.studentId, raised: msg.raised, username: ws.username, raisedAt: s.raisedAt }, [...teachers, ...students.values()].map(x => x.ws || x));
          broadcast({ type: "HAND_QUEUE", data: handQueue }, teachers);
        }
        break;
      }

      case "POLL_ANSWER": {
        const poll = polls.get(msg.pollId);
        if (poll && poll.active && !poll.answers[ws.studentId]) {
          poll.answers[ws.studentId] = { answer: msg.answer, username: ws.username, timestamp: Date.now() };
          const isCorrect = poll.correctAnswer ? msg.answer === poll.correctAnswer : null;
          ws.send(JSON.stringify({ type: "POLL_RESULT", pollId: msg.pollId, isCorrect, correctAnswer: poll.correctAnswer }));
          broadcast({ type: "POLL_ANSWER", studentId: ws.studentId, username: ws.username, answer: msg.answer, isCorrect, pollId: msg.pollId, answers: poll.answers }, teachers);
          logActivity(ws.studentId, "POLL_ANSWER", `${msg.pollId}:${msg.answer}`);
        }
        break;
      }

      case "STATUS_UPDATE": {
        const s = students.get(ws.studentId);
        if (s) { s.status = msg.status; logActivity(ws.studentId, "STATUS", msg.status); broadcast({ type: "STUDENT_STATUS", studentId: ws.studentId, status: msg.status }, teachers); }
        break;
      }

      case "TYPING":
        broadcast({ type: "TYPING", studentId: ws.studentId, username: ws.username, isTyping: msg.isTyping }, teachers);
        break;

      case "MESSAGE_REACTION":
        broadcast({ type: "MESSAGE_REACTION", messageId: msg.messageId, emoji: msg.emoji, studentId: ws.studentId, username: ws.username }, getAllWS());
        break;

      case "NOISE_LEVEL":
        if (msg.level > 0.75)
          broadcast({ type: "NOISE_WARNING", studentId: ws.studentId, username: ws.username, level: msg.level }, teachers);
        break;

      // NEW: Student whiteboard stroke (if allowed)
      case "WHITEBOARD_STROKE": {
        if (!adminConfig.allowStudentWhiteboard) return;
        const stroke = { ...msg.stroke, id: genId(4), timestamp: Date.now(), author: ws.studentId };
        whiteboardStrokes.push(stroke);
        if (whiteboardStrokes.length > 2000) whiteboardStrokes.shift();
        broadcast({ type: "WHITEBOARD_STROKE", stroke }, getAllWS());
        logActivity(ws.studentId, "WHITEBOARD");
        break;
      }

      // NEW: Student annotation
      case "ANNOTATION_ADD": {
        if (!adminConfig.allowStudentAnnotate) return;
        const ann = { ...msg.annotation, id: genId(4), author: ws.studentId, authorName: ws.username, timestamp: Date.now() };
        if (!annotations.has(ws.studentId)) annotations.set(ws.studentId, []);
        annotations.get(ws.studentId).push(ann);
        broadcast({ type: "ANNOTATION_ADD", annotation: ann }, teachers);
        logActivity(ws.studentId, "ANNOTATION");
        break;
      }

      // NEW: Focus check response
      case "FOCUS_RESPONSE": {
        logActivity(ws.studentId, "FOCUS_RESPONSE", msg.response);
        broadcast({ type: "FOCUS_RESPONSE", studentId: ws.studentId, username: ws.username, response: msg.response, checkId: msg.checkId }, teachers);
        updateAttentionScore(ws.studentId, "FOCUS_RESPONSE");
        break;
      }

      // NEW: Breakout room chat
      case "BREAKOUT_MSG": {
        const s = students.get(ws.studentId);
        if (!s || !s.breakoutRoom) return;
        const room = breakoutRooms.get(s.breakoutRoom);
        if (!room) return;
        const entry = { id: genId(4), text: String(msg.text || "").slice(0, 500), sender: ws.username, studentId: ws.studentId, timestamp: Date.now(), roomId: s.breakoutRoom };
        room.chatHistory.push(entry);
        // Send to all members of this room + teachers
        room.studentIds.forEach(sid => {
          const member = students.get(sid);
          if (member) member.ws.send(JSON.stringify({ type: "BREAKOUT_MSG", data: entry }));
        });
        broadcast({ type: "BREAKOUT_MSG", data: entry }, teachers);
        logActivity(ws.studentId, "BREAKOUT_CHAT", entry.text.slice(0, 80));
        break;
      }

      // NEW: Speed quiz response
      case "SPEED_QUIZ_ANSWER": {
        const quiz = quizzes.get(msg.quizId);
        if (quiz && quiz.active && !quiz.responses[ws.studentId]) {
          quiz.responses[ws.studentId] = { answer: msg.answer, username: ws.username, timestamp: Date.now() };
          broadcast({ type: "SPEED_QUIZ_RESPONSE", quizId: msg.quizId, studentId: ws.studentId, username: ws.username, answer: msg.answer }, teachers);
        }
        break;
      }

      // NEW: Remote control input from student (student can also deny)
      case "REMOTE_CONTROL_DENY": {
        remoteControlSessions.delete(ws.studentId);
        broadcast({ type: "REMOTE_CONTROL_STATUS", studentId: ws.studentId, active: false, reason: "denied" }, teachers);
        break;
      }

      // NEW: File request
      case "FILE_REQUEST": {
        const file = sharedFiles.find(f => f.id === msg.fileId);
        if (file) ws.send(JSON.stringify({ type: "FILE_DATA", file }));
        break;
      }

      // NEW: Student file share (if allowed)
      case "FILE_SHARE": {
        const file = {
          id: genId(4),
          name: msg.file.name,
          type: msg.file.type,
          size: msg.file.size,
          dataUrl: msg.file.dataUrl,
          sharedBy: ws.username,
          studentId: ws.studentId,
          timestamp: Date.now(),
        };
        sharedFiles.push(file);
        if (sharedFiles.length > 50) sharedFiles.shift();
        broadcast({ type: "FILE_SHARED", file: { id: file.id, name: file.name, size: file.size, type: file.type, sharedBy: file.sharedBy, timestamp: file.timestamp } }, [...teachers]);
        ws.send(JSON.stringify({ type: "FILE_SHARED", file: { id: file.id, name: file.name, size: file.size, type: file.type, sharedBy: file.sharedBy, timestamp: file.timestamp } }));
        logActivity(ws.studentId, "FILE_SHARE", file.name);
        break;
      }

      // NEW: Attention ping response
      case "ATTENTION_PING":
        updateAttentionScore(ws.studentId, "ATTENTION_PING");
        broadcast({ type: "ATTENTION_UPDATE", studentId: ws.studentId, score: attentionScores.get(ws.studentId)?.score || 100 }, teachers);
        break;
    }
  }

  // ── SHARED ──
  if (msg.type === "CHAT_MSG") {
    if (ws.role === "student" && !adminConfig.allowStudentChat) return;
    const entry = {
      id: genId(4),
      sender: ws.username || "Teacher",
      role: ws.role,
      studentId: ws.studentId || null,
      text: String(msg.text || "").slice(0, 500),
      timestamp: Date.now(),
      targetId: msg.targetId || null,
      starred: false,
    };
    chatHistory.push(entry);
    if (chatHistory.length > 200) chatHistory.shift();
    if (ws.role === "student") logActivity(ws.studentId, "CHAT", entry.text.slice(0, 80));
    broadcast({ type: "CHAT_MSG", data: entry }, getAllWS());
  }

  if (msg.type === "REACTION") {
    if (!adminConfig.allowStudentReactions && ws.role === "student") return;
    broadcast({ type: "REACTION", studentId: ws.studentId, username: ws.username || "Teacher", emoji: msg.emoji }, getAllWS());
  }
}

// ── BINARY MEDIA ──
function handleBinaryMedia(ws, rawData) {
  const typeCode = rawData[0]; // 83=S screen, 67=C cam, 65=A audio, 82=R remote input response

  if (ws.role === "student") {
    const payload = rawData.slice(1);
    if (typeCode === 83 || typeCode === 67) {
      const header = Buffer.from(ws.studentId + "|" + String.fromCharCode(typeCode), "utf8");
      const full = Buffer.concat([header, payload]);
      teachers.forEach(t => { if (t.readyState === WebSocket.OPEN) { try { t.send(full); } catch (_) {} } });

      if (typeCode === 83 && spotlightStudentId === ws.studentId) {
        const spotHeader = Buffer.from("SPOTLIGHT|S", "utf8");
        const spotFull = Buffer.concat([spotHeader, payload]);
        students.forEach(s => {
          if (s.ws !== ws && s.ws.readyState === WebSocket.OPEN) {
            try { s.ws.send(spotFull); } catch (_) {}
          }
        });
      }
    }

    if (typeCode === 65) {
      logActivity(ws.studentId, "AUDIO_CHUNK");
    }

    // Remote screenshot from student for remote control feedback
    if (typeCode === 82) {
      const header = Buffer.from(ws.studentId + "|R", "utf8");
      const full = Buffer.concat([header, rawData.slice(1)]);
      const session = remoteControlSessions.get(ws.studentId);
      if (session && session.teacherWs && session.teacherWs.readyState === WebSocket.OPEN) {
        try { session.teacherWs.send(full); } catch (_) {}
      }
    }
  }

  // Teacher binary (e.g., whiteboard bitmap data)
  if (ws.role === "teacher") {
    if (typeCode === 87) { // W = whiteboard image
      const payload = rawData.slice(1);
      const header = Buffer.from("WHITEBOARD|I", "utf8");
      const full = Buffer.concat([header, payload]);
      students.forEach(s => { if (s.ws.readyState === WebSocket.OPEN) { try { s.ws.send(full); } catch (_) {} } });
    }
  }
}

// ── SESSION STATS ──
function getSessionStats() {
  const uptime = Math.floor((Date.now() - sessionStartTime) / 1000);
  const avgAttention = attentionScores.size > 0
    ? Math.round(Array.from(attentionScores.values()).reduce((a, v) => a + v.score, 0) / attentionScores.size)
    : 100;
  return {
    uptime,
    studentCount: students.size,
    totalJoined,
    handCount: [...students.values()].filter(s => s.handRaised).length,
    mutedCount: [...students.values()].filter(s => s.muted).length,
    pollCount: polls.size,
    chatCount: chatHistory.length,
    classroomLocked,
    spotlightActive: !!spotlightStudentId,
    breakoutRoomCount: breakoutRooms.size,
    sharedFileCount: sharedFiles.length,
    avgAttentionScore: avgAttention,
    remoteControlCount: remoteControlSessions.size,
    whiteboardStrokes: whiteboardStrokes.length,
    handQueueLength: handQueue.length,
  };
}

function broadcastSessionStats() {
  const stats = getSessionStats();
  broadcast({ type: "SESSION_STATS", data: stats }, teachers);
}

// Periodic stats broadcast every 10s
setInterval(broadcastSessionStats, 10000);

console.log("✅ Server ready. Waiting for connections...");
console.log("📋 Features: Streams, Chat, Polls, Remote Control, Whiteboard, Annotations, Breakout Rooms, Timer, File Share, Attention Tracking, Laser Pointer, Speed Quiz, Hand Queue");