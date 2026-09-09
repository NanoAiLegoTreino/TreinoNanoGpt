(() => {
  "use strict";

  const STORAGE_KEY = "treinoNanoGpt.v1";
  const DEFAULT_STATE = {
    version: 1,
    sessionStartedAt: Date.now(),
    mode: "stopwatch",
    sets: 0,
    notes: [],
    draft: "",
    stopwatch: { status: "idle", startedAt: null, accumulatedMs: 0, laps: [] },
    countdown: { status: "idle", durationMs: 60000, deadline: null, pausedRemainingMs: 60000 },
    intervals: {
      status: "idle",
      config: { warmupSeconds: 60, workSeconds: 40, restSeconds: 20, rounds: 8 },
      phaseIndex: 0,
      phaseEndsAt: null,
      pausedRemainingMs: null
    }
  };

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const cloneDefaults = () => JSON.parse(JSON.stringify(DEFAULT_STATE));

  let state = loadState();
  let wakeLock = null;
  let audioContext = null;
  let displayInterval = null;
  let toastTimer = null;
  let saveTimer = null;
  let holdStartedAt = null;
  let holdFrame = null;

  const els = {
    timerStage: $("#timerStage"), timerTitle: $("#timerTitle"),
    timerDisplay: $("#timerDisplay"), timerDetail: $("#timerDetail"), toggleTimer: $("#toggleTimer"),
    resetTimer: $("#resetTimer"), lapTimer: $("#lapTimer"), laps: $("#laps"),
    countdownConfig: $("#countdownConfig"), intervalConfig: $("#intervalConfig"),
    countdownMinutes: $("#countdownMinutes"), countdownSeconds: $("#countdownSeconds"),
    warmupSeconds: $("#warmupSeconds"), workSeconds: $("#workSeconds"), restSeconds: $("#restSeconds"), rounds: $("#rounds"),
    setCount: $("#setCount"), noteInput: $("#noteInput"), notesList: $("#notesList"), notesCount: $("#notesCount"),
    copyFallback: $("#copyFallback"), fallbackText: $("#fallbackText"), toast: $("#toast"), newSession: $("#newSession")
  };

  function loadState() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (!saved || saved.version !== 1) return cloneDefaults();
      const clean = cloneDefaults();
      return {
        ...clean, ...saved,
        stopwatch: { ...clean.stopwatch, ...saved.stopwatch },
        countdown: { ...clean.countdown, ...saved.countdown },
        intervals: { ...clean.intervals, ...saved.intervals, config: { ...clean.intervals.config, ...saved.intervals?.config } },
        notes: Array.isArray(saved.notes) ? saved.notes : []
      };
    } catch (_) {
      return cloneDefaults();
    }
  }

  function saveState(immediate = false) {
    clearTimeout(saveTimer);
    const save = () => {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
      catch (_) { showToast("No se pudo guardar localmente"); }
    };
    if (immediate) save(); else saveTimer = setTimeout(save, 120);
  }

  function clampNumber(value, min, max, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.floor(number))) : fallback;
  }

  function formatClock(ms, tenths = false) {
    const safe = Math.max(0, ms);
    const totalSeconds = Math.floor(safe / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const base = hours > 0
      ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
      : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
    return tenths ? `${base}.${Math.floor((safe % 1000) / 100)}` : base;
  }

  function realTime(timestamp) {
    return new Intl.DateTimeFormat("es-AR", { hour: "2-digit", minute: "2-digit", hour12: false }).format(timestamp);
  }

  function getStopwatchElapsed(now = Date.now()) {
    const sw = state.stopwatch;
    return sw.accumulatedMs + (sw.status === "running" && sw.startedAt ? Math.max(0, now - sw.startedAt) : 0);
  }

  function intervalPhases() {
    const c = state.intervals.config;
    const phases = [];
    if (c.warmupSeconds > 0) phases.push({ type: "warmup", label: "WARM-UP", durationMs: c.warmupSeconds * 1000, round: 0 });
    for (let round = 1; round <= c.rounds; round += 1) {
      phases.push({ type: "work", label: "WORK", durationMs: c.workSeconds * 1000, round });
      if (c.restSeconds > 0 && round < c.rounds) phases.push({ type: "rest", label: "REST", durationMs: c.restSeconds * 1000, round });
    }
    return phases;
  }

  function isAnyTimerRunning() {
    return state.stopwatch.status === "running" || state.countdown.status === "running" || state.intervals.status === "running";
  }

  function syncDisplayLoop() {
    const shouldRun = isAnyTimerRunning() && document.visibilityState === "visible";
    if (shouldRun && displayInterval === null) {
      displayInterval = setInterval(() => renderTimer(Date.now()), 100);
    } else if (!shouldRun && displayInterval !== null) {
      clearInterval(displayInterval);
      displayInterval = null;
    }
  }

  function pauseOtherTimers(except) {
    const now = Date.now();
    if (except !== "stopwatch" && state.stopwatch.status === "running") {
      state.stopwatch.accumulatedMs = getStopwatchElapsed(now);
      state.stopwatch.startedAt = null;
      state.stopwatch.status = "paused";
    }
    if (except !== "countdown" && state.countdown.status === "running") {
      state.countdown.pausedRemainingMs = Math.max(0, state.countdown.deadline - now);
      state.countdown.deadline = null;
      state.countdown.status = "paused";
    }
    if (except !== "intervals" && state.intervals.status === "running") {
      state.intervals.pausedRemainingMs = Math.max(0, state.intervals.phaseEndsAt - now);
      state.intervals.phaseEndsAt = null;
      state.intervals.status = "paused";
    }
  }

  async function unlockAudio() {
    if (!audioContext) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) audioContext = new AudioCtx();
    }
    if (audioContext && audioContext.state !== "running" && audioContext.state !== "closed") {
      try { await audioContext.resume(); } catch (_) {}
    }
    return audioContext?.state === "running";
  }

  function beep(kind = "phase") {
    if (!audioContext || audioContext.state !== "running") return;
    const profiles = {
      work: { frequency: 950, count: 3, duration: .25, gap: .15, volume: .36 },
      rest: { frequency: 650, count: 2, duration: .25, gap: .15, volume: .34 },
      finish: { frequency: 880, count: 3, duration: .14, gap: .03, volume: .18 },
      phase: { frequency: 660, count: 1, duration: .14, gap: 0, volume: .18 }
    };
    const profile = profiles[kind] || profiles.phase;
    const now = audioContext.currentTime;
    for (let index = 0; index < profile.count; index += 1) {
      const start = now + index * (profile.duration + profile.gap);
      const release = start + profile.duration - .025;
      const osc = audioContext.createOscillator();
      const gain = audioContext.createGain();
      osc.frequency.value = profile.frequency;
      osc.type = "sine";
      gain.gain.setValueAtTime(.0001, start);
      gain.gain.exponentialRampToValueAtTime(profile.volume, start + .015);
      gain.gain.setValueAtTime(profile.volume, release);
      gain.gain.exponentialRampToValueAtTime(.0001, start + profile.duration);
      osc.connect(gain).connect(audioContext.destination);
      osc.start(start);
      osc.stop(start + profile.duration);
    }
  }

  function signal(kind = "phase") {
    if (audioContext?.state === "running") beep(kind);
    else if (audioContext && audioContext.state !== "closed") audioContext.resume().then(() => beep(kind)).catch(() => {});
  }

  async function requestWakeLock() {
    if (!isAnyTimerRunning() || document.visibilityState !== "visible" || !navigator.wakeLock || wakeLock) return;
    try {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; }, { once: true });
    } catch (_) { wakeLock = null; }
  }

  async function releaseWakeLock() {
    if (!wakeLock) return;
    const current = wakeLock;
    wakeLock = null;
    try { await current.release(); } catch (_) {}
  }

  function syncWakeLock() {
    syncDisplayLoop();
    if (isAnyTimerRunning()) requestWakeLock(); else releaseWakeLock();
  }

  function finishCountdown() {
    state.countdown.status = "finished";
    state.countdown.deadline = null;
    state.countdown.pausedRemainingMs = 0;
    saveState(true);
    syncWakeLock();
    signal("finish");
  }

  function reconcileIntervals(now = Date.now(), notify = true) {
    const timer = state.intervals;
    if (timer.status !== "running") return;
    const phases = intervalPhases();
    let changed = false;
    while (timer.phaseEndsAt !== null && now >= timer.phaseEndsAt) {
      timer.phaseIndex += 1;
      changed = true;
      if (timer.phaseIndex >= phases.length) {
        timer.status = "finished";
        timer.phaseEndsAt = null;
        timer.pausedRemainingMs = 0;
        saveState(true);
        syncWakeLock();
        if (notify) signal("finish");
        return;
      }
      timer.phaseEndsAt += phases[timer.phaseIndex].durationMs;
    }
    if (changed) {
      saveState(true);
      const phaseType = phases[timer.phaseIndex]?.type;
      if (notify && (phaseType === "work" || phaseType === "rest")) signal(phaseType);
    }
  }

  function renderTimer(now = Date.now()) {
    els.timerStage.className = "timer-stage";
    els.countdownConfig.hidden = state.mode !== "countdown" || state.countdown.status === "running";
    els.intervalConfig.hidden = state.mode !== "intervals" || state.intervals.status === "running";
    els.lapTimer.hidden = state.mode !== "stopwatch";
    els.laps.hidden = state.mode !== "stopwatch" || state.stopwatch.laps.length === 0;

    if (state.mode === "stopwatch") {
      const sw = state.stopwatch;
      els.timerTitle.textContent = sw.status === "running" ? "EN MARCHA" : sw.status === "paused" ? "PAUSADO" : "LISTO";
      els.timerDisplay.textContent = formatClock(getStopwatchElapsed(now), true);
      els.timerDetail.textContent = sw.laps.length ? `${sw.laps.length} ${sw.laps.length === 1 ? "vuelta" : "vueltas"}` : "Tiempo transcurrido";
      els.toggleTimer.textContent = sw.status === "running" ? "Pausar" : sw.status === "paused" ? "Reanudar" : "Iniciar";
      els.lapTimer.disabled = sw.status !== "running";
    } else if (state.mode === "countdown") {
      const cd = state.countdown;
      if (cd.status === "running" && now >= cd.deadline) finishCountdown();
      const remaining = cd.status === "running" ? Math.max(0, cd.deadline - now) : cd.pausedRemainingMs;
      els.timerTitle.textContent = cd.status === "finished" ? "FINALIZADO" : cd.status === "running" ? "CUENTA ATRÁS" : cd.status === "paused" ? "PAUSADO" : "LISTO";
      if (cd.status === "finished") els.timerStage.classList.add("finished");
      els.timerDisplay.textContent = formatClock(remaining);
      els.timerDetail.textContent = cd.status === "finished" ? "Tiempo cumplido" : "Tiempo restante";
      els.toggleTimer.textContent = cd.status === "running" ? "Pausar" : cd.status === "paused" ? "Reanudar" : cd.status === "finished" ? "Reiniciar" : "Iniciar";
    } else {
      reconcileIntervals(now);
      const timer = state.intervals;
      const phases = intervalPhases();
      const phase = phases[timer.phaseIndex] || phases[phases.length - 1];
      const remaining = timer.status === "running" ? Math.max(0, timer.phaseEndsAt - now) : timer.status === "finished" ? 0 : (timer.pausedRemainingMs ?? phase?.durationMs ?? 0);
      els.timerTitle.textContent = timer.status === "finished" ? "FINALIZADO" : phase?.label || "LISTO";
      if (phase) els.timerStage.classList.add(`phase-${phase.type}`);
      if (timer.status === "finished") els.timerStage.classList.add("finished");
      els.timerDisplay.textContent = formatClock(remaining);
      els.timerDetail.textContent = timer.status === "finished" ? `${timer.config.rounds} rondas completadas` : phase?.round ? `Ronda ${phase.round} de ${timer.config.rounds}` : `Preparación · ${timer.config.rounds} rondas`;
      els.toggleTimer.textContent = timer.status === "running" ? "Pausar" : timer.status === "paused" ? "Reanudar" : timer.status === "finished" ? "Reiniciar" : "Iniciar";
    }
  }

  function renderStatic() {
    $$(".mode-tab").forEach((button) => {
      const selected = button.dataset.mode === state.mode;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
    els.setCount.textContent = state.sets;
    els.noteInput.value = state.draft || "";
    els.notesCount.textContent = state.notes.length;
    els.countdownMinutes.value = Math.floor(state.countdown.durationMs / 60000);
    els.countdownSeconds.value = Math.floor((state.countdown.durationMs % 60000) / 1000);
    els.warmupSeconds.value = state.intervals.config.warmupSeconds;
    els.workSeconds.value = state.intervals.config.workSeconds;
    els.restSeconds.value = state.intervals.config.restSeconds;
    els.rounds.value = state.intervals.config.rounds;
    renderNotes();
    renderLaps();
    renderTimer();
  }

  function renderNotes() {
    els.notesList.replaceChildren();
    if (!state.notes.length) {
      const empty = document.createElement("p");
      empty.className = "empty-notes";
      empty.textContent = "Todavía no agregaste notas.";
      els.notesList.append(empty);
      return;
    }
    state.notes.forEach((note) => {
      const article = document.createElement("article");
      article.className = "note-item";
      const meta = document.createElement("time");
      meta.className = "note-meta";
      meta.dateTime = new Date(note.createdAt).toISOString();
      meta.textContent = realTime(note.createdAt);
      const text = document.createElement("p");
      text.className = "note-text";
      text.textContent = note.text;
      article.append(meta, text);
      els.notesList.append(article);
    });
  }

  function renderLaps() {
    els.laps.replaceChildren();
    [...state.stopwatch.laps].reverse().forEach((lap, index, reversed) => {
      const item = document.createElement("li");
      item.textContent = `Vuelta ${reversed.length - index} · ${formatClock(lap, true)}`;
      els.laps.append(item);
    });
  }

  function updateConfigFromInputs() {
    const minutes = clampNumber(els.countdownMinutes.value, 0, 599, 1);
    const seconds = clampNumber(els.countdownSeconds.value, 0, 59, 0);
    const durationMs = Math.max(1000, (minutes * 60 + seconds) * 1000);
    state.countdown.durationMs = durationMs;
    if (["idle", "finished"].includes(state.countdown.status)) state.countdown.pausedRemainingMs = durationMs;
    state.intervals.config = {
      warmupSeconds: clampNumber(els.warmupSeconds.value, 0, 3599, 60),
      workSeconds: clampNumber(els.workSeconds.value, 1, 3599, 40),
      restSeconds: clampNumber(els.restSeconds.value, 0, 3599, 20),
      rounds: clampNumber(els.rounds.value, 1, 99, 8)
    };
    if (["idle", "finished"].includes(state.intervals.status)) {
      state.intervals.phaseIndex = 0;
      state.intervals.pausedRemainingMs = intervalPhases()[0]?.durationMs || 0;
    }
    saveState();
    renderTimer();
  }

  async function toggleCurrentTimer() {
    await unlockAudio();
    const now = Date.now();
    pauseOtherTimers(state.mode);
    if (state.mode === "stopwatch") {
      const sw = state.stopwatch;
      if (sw.status === "running") {
        sw.accumulatedMs = getStopwatchElapsed(now);
        sw.startedAt = null;
        sw.status = "paused";
      } else {
        sw.startedAt = now;
        sw.status = "running";
      }
    } else if (state.mode === "countdown") {
      const cd = state.countdown;
      if (cd.status === "running") {
        cd.pausedRemainingMs = Math.max(0, cd.deadline - now);
        cd.deadline = null;
        cd.status = "paused";
      } else {
        if (cd.status === "finished") cd.pausedRemainingMs = cd.durationMs;
        cd.deadline = now + Math.max(1000, cd.pausedRemainingMs || cd.durationMs);
        cd.status = "running";
      }
    } else {
      const timer = state.intervals;
      const phases = intervalPhases();
      const beginsIntervalSession = timer.status === "idle" || timer.status === "finished";
      if (timer.status === "running") {
        timer.pausedRemainingMs = Math.max(0, timer.phaseEndsAt - now);
        timer.phaseEndsAt = null;
        timer.status = "paused";
      } else {
        if (timer.status === "finished") {
          timer.phaseIndex = 0;
          timer.pausedRemainingMs = phases[0]?.durationMs || 0;
        }
        const phase = phases[timer.phaseIndex];
        timer.phaseEndsAt = now + Math.max(1, timer.pausedRemainingMs ?? phase.durationMs);
        timer.status = "running";
        if (beginsIntervalSession && phase.type === "work") signal("work");
      }
    }
    saveState(true);
    syncWakeLock();
    renderStatic();
  }

  function resetCurrentTimer() {
    if (state.mode === "stopwatch") state.stopwatch = cloneDefaults().stopwatch;
    else if (state.mode === "countdown") state.countdown = { ...cloneDefaults().countdown, durationMs: state.countdown.durationMs, pausedRemainingMs: state.countdown.durationMs };
    else state.intervals = { ...cloneDefaults().intervals, config: { ...state.intervals.config }, pausedRemainingMs: intervalPhases()[0]?.durationMs || 0 };
    saveState(true);
    syncWakeLock();
    renderStatic();
  }

  function addNote() {
    const text = els.noteInput.value.trim();
    if (!text) { showToast("Escribí o dictá una nota primero"); return; }
    const createdAt = Date.now();
    state.notes.push({ id: `${createdAt}-${Math.random().toString(36).slice(2, 7)}`, text, createdAt });
    state.draft = "";
    saveState(true);
    renderStatic();
    showToast("Nota agregada");
  }

  function addNoteText(text) {
    const value = typeof text === "string" ? text.trim() : "";
    if (!value) throw new TypeError("La nota no puede estar vacía");
    const createdAt = Date.now();
    state.notes.push({ id: `${createdAt}-${Math.random().toString(36).slice(2, 7)}`, text: value, createdAt });
    saveState(true);
    renderStatic();
    return { saved: true, createdAt, noteCount: state.notes.length };
  }

  function sessionSummary() {
    const start = new Date(state.sessionStartedAt);
    const date = new Intl.DateTimeFormat("es-AR", { dateStyle: "long" }).format(start);
    const lines = [
      "TREINONANOGPT — SESIÓN",
      `Fecha: ${date}`,
      `Inicio: ${realTime(state.sessionStartedAt)}`,
      `Series contadas: ${state.sets}`,
      "",
      "NOTAS"
    ];
    if (state.notes.length) state.notes.forEach((note) => lines.push(`[${realTime(note.createdAt)}] ${note.text}`));
    else lines.push("(Sin notas)");
    if (state.draft.trim()) lines.push("", `BORRADOR SIN AGREGAR: ${state.draft.trim()}`);
    lines.push("", "— Exportado desde TreinoNanoGpt");
    return lines.join("\n");
  }

  async function copySession() {
    const text = sessionSummary();
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard API no disponible");
      await navigator.clipboard.writeText(text);
      showToast("Sesión copiada para ChatGPT");
    } catch (_) {
      els.fallbackText.value = text;
      els.copyFallback.showModal();
      requestAnimationFrame(() => { els.fallbackText.focus(); els.fallbackText.select(); });
    }
  }

  function showToast(message) {
    clearTimeout(toastTimer);
    els.toast.textContent = message;
    els.toast.classList.add("show");
    toastTimer = setTimeout(() => els.toast.classList.remove("show"), 2200);
  }

  function startHold(event) {
    if (event.type === "keydown" && !["Enter", " "].includes(event.key)) return;
    if (holdStartedAt !== null) return;
    if (event.cancelable) event.preventDefault();
    holdStartedAt = Date.now();
    const draw = () => {
      if (holdStartedAt === null) return;
      const progress = Math.min(1, (Date.now() - holdStartedAt) / 2000);
      els.newSession.style.setProperty("--hold-progress", progress);
      if (progress >= 1) {
        completeNewSession();
      } else holdFrame = requestAnimationFrame(draw);
    };
    holdFrame = requestAnimationFrame(draw);
  }

  function cancelHold() {
    holdStartedAt = null;
    cancelAnimationFrame(holdFrame);
    els.newSession.style.setProperty("--hold-progress", 0);
  }

  function completeNewSession() {
    cancelHold();
    releaseWakeLock();
    state = cloneDefaults();
    state.sessionStartedAt = Date.now();
    localStorage.removeItem(STORAGE_KEY);
    saveState(true);
    renderStatic();
    showToast("Nueva sesión iniciada");
  }

  $$(".mode-tab").forEach((button) => button.addEventListener("click", () => {
    pauseOtherTimers(button.dataset.mode);
    state.mode = button.dataset.mode;
    saveState(true);
    syncWakeLock();
    renderStatic();
  }));
  els.toggleTimer.addEventListener("click", toggleCurrentTimer);
  els.resetTimer.addEventListener("click", resetCurrentTimer);
  els.lapTimer.addEventListener("click", () => {
    if (state.stopwatch.status !== "running") return;
    state.stopwatch.laps.push(getStopwatchElapsed());
    saveState(true);
    renderStatic();
  });
  [els.countdownMinutes, els.countdownSeconds, els.warmupSeconds, els.workSeconds, els.restSeconds, els.rounds].forEach((input) => input.addEventListener("change", updateConfigFromInputs));
  $("#incrementSet").addEventListener("click", () => { state.sets += 1; saveState(true); renderStatic(); });
  $("#decrementSet").addEventListener("click", () => { state.sets = Math.max(0, state.sets - 1); saveState(true); renderStatic(); });
  $("#resetSets").addEventListener("click", () => { state.sets = 0; saveState(true); renderStatic(); });
  els.noteInput.addEventListener("input", () => { state.draft = els.noteInput.value; saveState(); });
  els.noteInput.addEventListener("keydown", (event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") addNote(); });
  $("#addNote").addEventListener("click", addNote);
  $("#copySession").addEventListener("click", copySession);
  els.newSession.addEventListener("pointerdown", startHold);
  ["pointerup", "pointercancel", "pointerleave"].forEach((name) => els.newSession.addEventListener(name, cancelHold));
  els.newSession.addEventListener("keydown", startHold);
  els.newSession.addEventListener("keyup", cancelHold);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      reconcileIntervals(Date.now(), true);
      syncWakeLock();
      renderTimer();
    } else {
      syncDisplayLoop();
      if (wakeLock) releaseWakeLock();
    }
  });
  window.addEventListener("pagehide", () => saveState(true));

  renderStatic();
  reconcileIntervals(Date.now(), false);
  syncWakeLock();

  if (document.modelContext?.registerTool) {
    try {
      Promise.resolve(document.modelContext.registerTool({
        name: "add_session_note",
        title: "Agregar nota de sesión",
        description: "Agrega una nota libre al entrenamiento actual con la hora automática.",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string", minLength: 1, maxLength: 5000 } },
          required: ["text"],
          additionalProperties: false
        },
        annotations: { readOnlyHint: false, untrustedContentHint: false },
        execute(input) {
          if (!input || typeof input !== "object" || typeof input.text !== "string" || !input.text.trim() || input.text.length > 5000) {
            throw new TypeError("Se requiere text entre 1 y 5000 caracteres");
          }
          return addNoteText(input.text);
        }
      })).catch(() => {});
    } catch (_) {}
  }

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => navigator.serviceWorker.register("./service-worker.js").catch(() => {}));
  }
})();
