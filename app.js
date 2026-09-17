(() => {
  "use strict";

  const STORAGE_KEY = "treinoNanoGpt.v1";
  const DEFAULT_STATE = {
    version: 2,
    sessionStartedAt: null,
    session: { status: "idle", startedAt: null, endedAt: null, activeBlockId: null, blocks: [] },
    mode: "stopwatch",
    sets: 0,
    notes: [],
    draft: "",
    sessionHistory: [],
    stopwatch: { status: "idle", startedAt: null, accumulatedMs: 0, laps: [], runId: null, activityStartedAt: null, blockId: null },
    countdown: { status: "idle", durationMs: 60000, deadline: null, pausedRemainingMs: 60000, runId: null, activityStartedAt: null, blockId: null },
    intervals: {
      status: "idle",
      config: { warmupSeconds: 60, workSeconds: 40, restSeconds: 20, rounds: 8 },
      phaseIndex: 0,
      phaseEndsAt: null,
      pausedRemainingMs: null,
      runId: null,
      activityStartedAt: null,
      blockId: null
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
  let blockToggleGuardUntil = 0;

  const els = {
    sessionCard: $("#sessionCard"), sessionIdle: $("#sessionIdle"), blockActive: $("#blockActive"), blockFinished: $("#blockFinished"), sessionFinished: $("#sessionFinished"),
    startSession: $("#startSession"), blockStateIcon: $("#blockStateIcon"), blockStatus: $("#blockStatus"), blockTime: $("#blockTime"),
    toggleBlock: $("#toggleBlock"), finishBlock: $("#finishBlock"), nextBlock: $("#nextBlock"), finishSession: $("#finishSession"),
    finishedBlockTitle: $("#finishedBlockTitle"), finishedBlockSummary: $("#finishedBlockSummary"), sessionFinishedSummary: $("#sessionFinishedSummary"),
    timerStage: $("#timerStage"), timerTitle: $("#timerTitle"),
    timerDisplay: $("#timerDisplay"), timerDetail: $("#timerDetail"), toggleTimer: $("#toggleTimer"),
    resetTimer: $("#resetTimer"), lapTimer: $("#lapTimer"), laps: $("#laps"), lapsPanel: $("#lapsPanel"), lapsSummary: $("#lapsSummary"),
    countdownConfig: $("#countdownConfig"), intervalConfig: $("#intervalConfig"),
    countdownMinutes: $("#countdownMinutes"), countdownSeconds: $("#countdownSeconds"),
    warmupSeconds: $("#warmupSeconds"), workSeconds: $("#workSeconds"), restSeconds: $("#restSeconds"), rounds: $("#rounds"),
    setCount: $("#setCount"), noteInput: $("#noteInput"), notesList: $("#notesList"), notesCount: $("#notesCount"),
    copyFallback: $("#copyFallback"), fallbackText: $("#fallbackText"), toast: $("#toast"), newSession: $("#newSession")
  };

  function loadState() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (!saved || ![1, 2].includes(saved.version)) return cloneDefaults();
      const clean = cloneDefaults();
      const loaded = {
        ...clean, ...saved,
        stopwatch: { ...clean.stopwatch, ...saved.stopwatch },
        countdown: { ...clean.countdown, ...saved.countdown },
        intervals: { ...clean.intervals, ...saved.intervals, config: { ...clean.intervals.config, ...saved.intervals?.config } },
        version: 2,
        session: saved.session && typeof saved.session === "object"
          ? { ...clean.session, ...saved.session, blocks: Array.isArray(saved.session.blocks) ? saved.session.blocks : [] }
          : { ...clean.session },
        notes: Array.isArray(saved.notes) ? saved.notes : [],
        sessionHistory: Array.isArray(saved.sessionHistory)
          ? saved.sessionHistory.filter((item) => item && typeof item === "object").map((item, index) => ({ ...item, id: item.id || `legacy-history-${index}-${item.startedAt || item.endedAt || Date.now()}` }))
          : []
      };
      const seenHistoryIds = new Set();
      loaded.sessionHistory = loaded.sessionHistory.filter((item) => {
        if (seenHistoryIds.has(item.id)) return false;
        seenHistoryIds.add(item.id);
        return true;
      });
      migrateCurrentActivityMetadata(loaded);
      migrateSessionStructure(loaded, saved);
      return loaded;
    } catch (_) {
      return cloneDefaults();
    }
  }

  function createRunId(type, timestamp = Date.now()) {
    return `${type}-${timestamp}-${Math.random().toString(36).slice(2, 9)}`;
  }

  function createBlock(number, timestamp = Date.now()) {
    return {
      id: "block-" + number + "-" + timestamp + "-" + Math.random().toString(36).slice(2, 8),
      number,
      status: "running",
      startedAt: timestamp,
      endedAt: null,
      accumulatedMs: 0,
      runStartedAt: timestamp,
      pauseStartedAt: null,
      pauses: [],
      activityIds: [],
      setEvents: []
    };
  }

  function hasLegacySessionContent(saved) {
    return Boolean(
      saved?.sessionHistory?.length || saved?.notes?.length || saved?.draft?.trim?.() || Number(saved?.sets) > 0 ||
      saved?.stopwatch?.status !== "idle" || saved?.countdown?.status !== "idle" || saved?.intervals?.status !== "idle"
    );
  }

  function migrateSessionStructure(loaded, saved) {
    const now = Date.now();
    if (!saved.session || !Array.isArray(saved.session.blocks)) {
      if (!hasLegacySessionContent(saved)) {
        loaded.session = { ...cloneDefaults().session };
        loaded.sessionStartedAt = null;
        return;
      }
      const block = createBlock(1, now);
      loaded.session = {
        status: "active",
        startedAt: Number(saved.sessionStartedAt) || now,
        endedAt: null,
        activeBlockId: block.id,
        blocks: [block]
      };
      loaded.sessionStartedAt = loaded.session.startedAt;
    } else {
      loaded.session.blocks = loaded.session.blocks.map((block, index) => ({
        id: block.id || "block-" + (index + 1) + "-" + (block.startedAt || now),
        number: Number(block.number) || index + 1,
        status: ["running", "paused", "completed"].includes(block.status) ? block.status : "completed",
        startedAt: Number(block.startedAt) || now,
        endedAt: Number(block.endedAt) || null,
        accumulatedMs: Math.max(0, Number(block.accumulatedMs) || 0),
        runStartedAt: Number(block.runStartedAt) || null,
        pauseStartedAt: Number(block.pauseStartedAt) || null,
        pauses: Array.isArray(block.pauses) ? block.pauses : [],
        activityIds: Array.isArray(block.activityIds) ? [...new Set(block.activityIds)] : [],
        setEvents: Array.isArray(block.setEvents) ? block.setEvents : []
      }));
      if (!["idle", "active", "finished"].includes(loaded.session.status)) loaded.session.status = "idle";
      loaded.sessionStartedAt = loaded.session.startedAt || null;
      const active = loaded.session.blocks.find((block) => block.id === loaded.session.activeBlockId);
      if (loaded.session.status === "active" && loaded.session.activeBlockId && !active) loaded.session.activeBlockId = null;
      if (active?.status === "completed") loaded.session.activeBlockId = null;
    }

    const fallbackBlock = loaded.session.blocks[0] || null;
    loaded.sessionHistory = loaded.sessionHistory.map((item) => ({ ...item, blockId: item.blockId || fallbackBlock?.id || null }));
    loaded.notes = loaded.notes.map((note) => ({ ...note, blockId: note.blockId || fallbackBlock?.id || null }));
    [loaded.stopwatch, loaded.countdown, loaded.intervals].forEach((timer) => {
      if (timer.runId && !timer.blockId) timer.blockId = loaded.session.activeBlockId || fallbackBlock?.id || null;
    });
    loaded.sessionHistory.forEach((item) => {
      const block = loaded.session.blocks.find((candidate) => candidate.id === item.blockId);
      if (block && !block.activityIds.includes(item.id)) block.activityIds.push(item.id);
    });
  }

  function migrateCurrentActivityMetadata(loaded) {
    const now = Date.now();
    const sw = loaded.stopwatch;
    if (!sw.runId && (sw.status !== "idle" || sw.accumulatedMs > 0 || sw.laps.length > 0)) {
      sw.runId = createRunId("stopwatch", now);
      sw.activityStartedAt = sw.startedAt ? sw.startedAt - sw.accumulatedMs : now - sw.accumulatedMs;
    }
    const cd = loaded.countdown;
    if (!cd.runId && cd.status !== "idle") {
      const remaining = cd.status === "running" && cd.deadline ? Math.max(0, cd.deadline - now) : cd.pausedRemainingMs;
      cd.runId = createRunId("countdown", now);
      cd.activityStartedAt = now - Math.max(0, cd.durationMs - (remaining ?? cd.durationMs));
    }
    const timer = loaded.intervals;
    if (!timer.runId && timer.status !== "idle") {
      timer.runId = createRunId("intervals", now);
      timer.activityStartedAt = now;
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

  function currentBlock() {
    return state.session.blocks.find((block) => block.id === state.session.activeBlockId) || null;
  }

  function blockById(blockId) {
    return state.session.blocks.find((block) => block.id === blockId) || null;
  }

  function blockEffectiveMs(block, now = Date.now()) {
    if (!block) return 0;
    return Math.max(0, Number(block.accumulatedMs) || 0) +
      (block.status === "running" && block.runStartedAt ? Math.max(0, now - block.runStartedAt) : 0);
  }

  function blockPausedMs(block, now = Date.now()) {
    if (!block) return 0;
    const completedPauses = block.pauses.reduce((total, pause) => total + Math.max(0, Number(pause.durationMs) || 0), 0);
    const currentPause = block.status === "paused" && block.pauseStartedAt ? Math.max(0, now - block.pauseStartedAt) : 0;
    return completedPauses + currentPause;
  }

  function sessionEffectiveMs(now = Date.now()) {
    return state.session.blocks.reduce((total, block) => total + blockEffectiveMs(block, now), 0);
  }

  function sessionElapsedMs(now = Date.now()) {
    if (!state.session.startedAt) return 0;
    const end = state.session.endedAt || now;
    return Math.max(0, end - state.session.startedAt);
  }

  function sessionPauseMs(now = Date.now()) {
    return Math.max(0, sessionElapsedMs(now) - sessionEffectiveMs(now));
  }

  function hasCurrentBlock() {
    return state.session.status === "active" && Boolean(currentBlock());
  }

  function hasRunningBlock() {
    return currentBlock()?.status === "running";
  }

  function ensureRunningBlock() {
    if (hasRunningBlock()) return currentBlock();
    showToast(currentBlock()?.status === "paused" ? "Reanudá el bloque para usar el timer" : "Iniciá una sesión y un bloque primero");
    return null;
  }

  function recordSetEvent(type, before, after, timestamp = Date.now()) {
    const block = currentBlock();
    if (!block || state.session.status !== "active") return false;
    block.setEvents.push({ id: createRunId("set", timestamp), type, before, after, createdAt: timestamp });
    return true;
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

  function historyTime(item) {
    return Number(item.startedAt) || Number(item.endedAt) || 0;
  }

  function addHistoryItem(item) {
    if (!item?.id || state.sessionHistory.some((saved) => saved.id === item.id)) return false;
    state.sessionHistory.push(item);
    state.sessionHistory.sort((a, b) => historyTime(a) - historyTime(b));
    const block = blockById(item.blockId);
    if (block && !block.activityIds.includes(item.id)) block.activityIds.push(item.id);
    return true;
  }

  function isArchived(runId) {
    return Boolean(runId) && state.sessionHistory.some((item) => item.id === runId);
  }

  function stopwatchSnapshot(now = Date.now(), status = null) {
    const sw = state.stopwatch;
    if (!sw.runId || sw.status === "idle") return null;
    const durationMs = getStopwatchElapsed(now);
    return {
      id: sw.runId,
      type: "stopwatch",
      startedAt: sw.activityStartedAt || now - durationMs,
      endedAt: status === "completed" ? now : null,
      durationMs,
      laps: [...sw.laps],
      lapCount: sw.laps.length,
      status: status || sw.status,
      blockId: sw.blockId
    };
  }

  function countdownSnapshot(status = null, endedAt = null) {
    const cd = state.countdown;
    if (!cd.runId || cd.status === "idle") return null;
    const resolvedStatus = status || (cd.status === "finished" ? "completed" : cd.status);
    return {
      id: cd.runId,
      type: "countdown",
      startedAt: cd.activityStartedAt || Date.now(),
      endedAt: endedAt || (resolvedStatus === "completed" || resolvedStatus === "interrupted" ? Date.now() : null),
      durationMs: cd.durationMs,
      status: resolvedStatus,
      blockId: cd.blockId
    };
  }

  function intervalsSnapshot(status = null, endedAt = null) {
    const timer = state.intervals;
    if (!timer.runId || timer.status === "idle") return null;
    const resolvedStatus = status || (timer.status === "finished" ? "completed" : timer.status);
    return {
      id: timer.runId,
      type: "intervals",
      startedAt: timer.activityStartedAt || Date.now(),
      endedAt: endedAt || (resolvedStatus === "completed" || resolvedStatus === "interrupted" ? Date.now() : null),
      config: { ...timer.config },
      status: resolvedStatus,
      blockId: timer.blockId
    };
  }

  function archiveStopwatch(now = Date.now()) {
    const item = stopwatchSnapshot(now, "completed");
    return item ? addHistoryItem(item) : false;
  }

  function archiveCountdown(status, endedAt = Date.now()) {
    const item = countdownSnapshot(status, endedAt);
    return item ? addHistoryItem(item) : false;
  }

  function archiveIntervals(status, endedAt = Date.now()) {
    const item = intervalsSnapshot(status, endedAt);
    return item ? addHistoryItem(item) : false;
  }

  function currentActivitySnapshots(now = Date.now()) {
    return [stopwatchSnapshot(now), countdownSnapshot(), intervalsSnapshot()]
      .filter((item) => item && !isArchived(item.id));
  }

  function isAnyTimerRunning() {
    return state.stopwatch.status === "running" || state.countdown.status === "running" || state.intervals.status === "running";
  }

  function isAnyClockRunning() {
    return isAnyTimerRunning() || hasRunningBlock();
  }

  function syncDisplayLoop() {
    const shouldRun = isAnyClockRunning() && document.visibilityState === "visible";
    if (shouldRun && displayInterval === null) {
      displayInterval = setInterval(() => {
        const now = Date.now();
        renderTimer(now);
        renderSession(now);
      }, 100);
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
      phase: { frequency: 660, count: 1, duration: .14, gap: 0, volume: .18 },
      action: { frequency: 1180, count: 1, duration: .1, gap: 0, volume: .14 }
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

  async function confirmAction() {
    await unlockAudio();
    signal("action");
  }

  async function requestWakeLock() {
    if (!isAnyClockRunning() || document.visibilityState !== "visible" || !navigator.wakeLock || wakeLock) return;
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
    if (isAnyClockRunning()) requestWakeLock(); else releaseWakeLock();
  }

  function archiveAndResetTimers(now = Date.now()) {
    if (state.stopwatch.runId) archiveStopwatch(now);
    if (state.countdown.runId) {
      archiveCountdown(state.countdown.status === "finished" ? "completed" : "interrupted", now);
    }
    if (state.intervals.runId) {
      archiveIntervals(state.intervals.status === "finished" ? "completed" : "interrupted", now);
    }
    const countdownDuration = state.countdown.durationMs;
    const intervalConfig = { ...state.intervals.config };
    state.stopwatch = cloneDefaults().stopwatch;
    state.countdown = { ...cloneDefaults().countdown, durationMs: countdownDuration, pausedRemainingMs: countdownDuration };
    state.intervals = { ...cloneDefaults().intervals, config: intervalConfig };
    state.intervals.pausedRemainingMs = intervalPhases()[0]?.durationMs || 0;
  }

  function startSession() {
    if (state.session.status !== "idle") return;
    const now = Date.now();
    const block = createBlock(1, now);
    state.session = { status: "active", startedAt: now, endedAt: null, activeBlockId: block.id, blocks: [block] };
    state.sessionStartedAt = now;
    saveState(true);
    syncWakeLock();
    renderStatic();
    showToast("Sesión y Bloque 1 iniciados");
  }

  function toggleCurrentBlock() {
    const block = currentBlock();
    if (!block || state.session.status !== "active" || block.status === "completed") return;
    const now = Date.now();
    if (now < blockToggleGuardUntil) return;
    blockToggleGuardUntil = now + 450;
    if (block.status === "running") {
      block.accumulatedMs = blockEffectiveMs(block, now);
      block.runStartedAt = null;
      block.status = "paused";
      block.pauseStartedAt = now;
      pauseOtherTimers(null);
      showToast("Bloque pausado");
    } else if (block.status === "paused") {
      if (block.pauseStartedAt) {
        block.pauses.push({ startedAt: block.pauseStartedAt, endedAt: now, durationMs: Math.max(0, now - block.pauseStartedAt) });
      }
      block.pauseStartedAt = null;
      block.runStartedAt = now;
      block.status = "running";
      showToast("Bloque reanudado");
    }
    saveState(true);
    syncWakeLock();
    renderStatic();
  }

  function finishActiveBlock(now = Date.now(), shouldRender = true) {
    const block = currentBlock();
    if (!block || state.session.status !== "active" || block.status === "completed") return false;
    if (block.status === "running") {
      block.accumulatedMs = blockEffectiveMs(block, now);
    } else if (block.status === "paused" && block.pauseStartedAt) {
      block.pauses.push({ startedAt: block.pauseStartedAt, endedAt: now, durationMs: Math.max(0, now - block.pauseStartedAt) });
    }
    block.runStartedAt = null;
    block.pauseStartedAt = null;
    archiveAndResetTimers(now);
    block.status = "completed";
    block.endedAt = now;
    state.session.activeBlockId = null;
    saveState(true);
    syncWakeLock();
    if (shouldRender) {
      renderStatic();
      showToast("Bloque " + block.number + " finalizado");
    }
    return true;
  }

  function startNextBlock() {
    if (state.session.status !== "active" || currentBlock()) return;
    const lastBlock = state.session.blocks[state.session.blocks.length - 1];
    if (!lastBlock || lastBlock.status !== "completed") return;
    const nextNumber = Math.max(...state.session.blocks.map((block) => block.number), 0) + 1;
    const block = createBlock(nextNumber);
    state.session.blocks.push(block);
    state.session.activeBlockId = block.id;
    saveState(true);
    syncWakeLock();
    renderStatic();
    showToast("Bloque " + nextNumber + " iniciado");
  }

  function finishCurrentSession() {
    if (state.session.status !== "active") return;
    const now = Date.now();
    if (currentBlock()) finishActiveBlock(now, false);
    state.session.status = "finished";
    state.session.endedAt = now;
    state.session.activeBlockId = null;
    saveState(true);
    syncWakeLock();
    renderStatic();
    showToast("Sesión finalizada");
  }

  function finishCountdown() {
    const completedAt = state.countdown.deadline || Date.now();
    state.countdown.status = "finished";
    state.countdown.deadline = null;
    state.countdown.pausedRemainingMs = 0;
    archiveCountdown("completed", completedAt);
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
        const completedAt = timer.phaseEndsAt;
        timer.status = "finished";
        timer.phaseEndsAt = null;
        timer.pausedRemainingMs = 0;
        archiveIntervals("completed", completedAt);
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
    els.lapsPanel.hidden = state.mode !== "stopwatch" || state.stopwatch.laps.length === 0;

    if (state.mode === "stopwatch") {
      const sw = state.stopwatch;
      els.timerTitle.textContent = sw.status === "running" ? "EN MARCHA" : sw.status === "paused" ? "PAUSADO" : "LISTO";
      els.timerDisplay.textContent = formatClock(getStopwatchElapsed(now), true);
      els.timerDetail.textContent = sw.laps.length ? `${sw.laps.length} ${sw.laps.length === 1 ? "vuelta" : "vueltas"}` : "Tiempo transcurrido";
      els.toggleTimer.textContent = sw.status === "running" ? "Pausar" : sw.status === "paused" ? "Reanudar" : "Iniciar";
      els.lapTimer.disabled = sw.status !== "running" || !hasRunningBlock();
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
    els.toggleTimer.classList.toggle("pause", state[state.mode].status === "running");
    els.toggleTimer.disabled = !hasRunningBlock();
    els.resetTimer.disabled = !hasCurrentBlock();
  }

  function renderSession(now = Date.now()) {
    const sessionStatus = state.session.status;
    const block = currentBlock();
    els.sessionIdle.hidden = sessionStatus !== "idle";
    els.blockActive.hidden = !(sessionStatus === "active" && block);
    els.blockFinished.hidden = !(sessionStatus === "active" && !block && state.session.blocks.length);
    els.sessionFinished.hidden = sessionStatus !== "finished";
    els.sessionCard.classList.toggle("is-live", sessionStatus === "active" && Boolean(block));

    if (block) {
      const paused = block.status === "paused";
      els.blockActive.classList.toggle("paused", paused);
      els.blockStateIcon.textContent = paused ? "Ⅱ" : "●";
      els.blockStatus.textContent = "BLOQUE " + block.number + (paused ? " PAUSADO" : " EN CURSO");
      els.blockTime.textContent = formatClock(blockEffectiveMs(block, now));
      els.toggleBlock.textContent = paused ? "REANUDAR BLOQUE" : "PAUSAR BLOQUE";
      els.toggleBlock.classList.toggle("resume", paused);
    }

    if (sessionStatus === "active" && !block && state.session.blocks.length) {
      const lastBlock = state.session.blocks[state.session.blocks.length - 1];
      els.finishedBlockTitle.textContent = "Bloque " + lastBlock.number + " guardado";
      els.finishedBlockSummary.textContent = "Duración efectiva: " + formatClock(blockEffectiveMs(lastBlock, now));
    }

    if (sessionStatus === "finished") {
      els.sessionFinishedSummary.textContent =
        "Tiempo efectivo: " + formatClock(sessionEffectiveMs(now)) +
        " · Transcurrido: " + formatClock(sessionElapsedMs(now));
    }

    const blockAvailable = sessionStatus === "active" && Boolean(block);
    $("#incrementSet").disabled = !blockAvailable;
    $("#decrementSet").disabled = !blockAvailable;
    $("#resetSets").disabled = !blockAvailable;
    els.noteInput.disabled = !blockAvailable;
    $("#addNote").disabled = !blockAvailable;
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
    renderSession();
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
      const noteBlock = blockById(note.blockId);
      meta.textContent = realTime(note.createdAt) + (noteBlock ? " · BLOQUE " + noteBlock.number : "");
      const text = document.createElement("p");
      text.className = "note-text";
      text.textContent = note.text;
      article.append(meta, text);
      els.notesList.append(article);
    });
  }

  function renderLaps() {
    els.laps.replaceChildren();
    els.lapsSummary.textContent = `${state.stopwatch.laps.length} ${state.stopwatch.laps.length === 1 ? "vuelta registrada" : "vueltas registradas"}`;
    [...state.stopwatch.laps].reverse().forEach((lap, index, reversed) => {
      const item = document.createElement("li");
      const label = document.createElement("span");
      label.textContent = `Vuelta ${reversed.length - index}`;
      const time = document.createElement("strong");
      time.textContent = formatClock(lap, true);
      item.append(label, time);
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
    const block = ensureRunningBlock();
    if (!block) return;
    await unlockAudio();
    signal("action");
    const now = Date.now();
    pauseOtherTimers(state.mode);
    if (state.mode === "stopwatch") {
      const sw = state.stopwatch;
      if (sw.status === "running") {
        sw.accumulatedMs = getStopwatchElapsed(now);
        sw.startedAt = null;
        sw.status = "paused";
      } else {
        if (!sw.runId) {
          sw.runId = createRunId("stopwatch", now);
          sw.activityStartedAt = now;
          sw.blockId = block.id;
        }
        sw.startedAt = now;
        sw.status = "running";
      }
    } else if (state.mode === "countdown") {
      const cd = state.countdown;
      const beginsCountdown = cd.status === "idle" || cd.status === "finished";
      if (cd.status === "running") {
        cd.pausedRemainingMs = Math.max(0, cd.deadline - now);
        cd.deadline = null;
        cd.status = "paused";
      } else {
        if (cd.status === "finished") cd.pausedRemainingMs = cd.durationMs;
        if (beginsCountdown) {
          cd.runId = createRunId("countdown", now);
          cd.activityStartedAt = now;
          cd.blockId = block.id;
        }
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
        if (beginsIntervalSession) {
          timer.runId = createRunId("intervals", now);
          timer.activityStartedAt = now;
          timer.blockId = block.id;
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

  async function resetCurrentTimer() {
    await confirmAction();
    const now = Date.now();
    if (state.mode === "stopwatch") {
      archiveStopwatch(now);
      state.stopwatch = cloneDefaults().stopwatch;
    } else if (state.mode === "countdown") {
      archiveCountdown(state.countdown.status === "finished" ? "completed" : "interrupted", now);
      state.countdown = { ...cloneDefaults().countdown, durationMs: state.countdown.durationMs, pausedRemainingMs: state.countdown.durationMs };
    } else {
      archiveIntervals(state.intervals.status === "finished" ? "completed" : "interrupted", now);
      state.intervals = { ...cloneDefaults().intervals, config: { ...state.intervals.config }, pausedRemainingMs: intervalPhases()[0]?.durationMs || 0 };
    }
    saveState(true);
    syncWakeLock();
    renderStatic();
  }

  function addNote() {
    const text = els.noteInput.value.trim();
    if (!text) { showToast("Escribí o dictá una nota primero"); return; }
    const block = currentBlock();
    if (!block || state.session.status !== "active") { showToast("Iniciá una sesión primero"); return; }
    confirmAction();
    const createdAt = Date.now();
    state.notes.push({ id: `${createdAt}-${Math.random().toString(36).slice(2, 7)}`, text, createdAt, blockId: block.id });
    state.draft = "";
    saveState(true);
    renderStatic();
    showToast("Nota agregada");
  }

  function addNoteText(text) {
    const value = typeof text === "string" ? text.trim() : "";
    if (!value) throw new TypeError("La nota no puede estar vacía");
    const block = currentBlock();
    if (!block || state.session.status !== "active") throw new Error("No hay un bloque activo");
    const createdAt = Date.now();
    state.notes.push({ id: `${createdAt}-${Math.random().toString(36).slice(2, 7)}`, text: value, createdAt, blockId: block.id });
    saveState(true);
    renderStatic();
    return { saved: true, createdAt, noteCount: state.notes.length };
  }

  function activityStatusLabel(status) {
    return ({
      completed: "Completado",
      interrupted: "Interrumpido",
      running: "En curso",
      paused: "Pausado",
      finished: "Completado"
    })[status] || "Registrado";
  }

  function activitySummaryLines(item) {
    const timestamp = historyTime(item) || state.session.startedAt || Date.now();
    const labels = { stopwatch: "CRONÓMETRO", countdown: "CUENTA REGRESIVA", intervals: "INTERVALOS" };
    const lines = [`[${realTime(timestamp)}] ${labels[item.type] || item.type.toUpperCase()}`];
    if (item.type === "stopwatch") {
      lines.push(`Duración: ${formatClock(item.durationMs || 0, true)}`);
      const laps = Array.isArray(item.laps) ? item.laps : [];
      lines.push(`Vueltas: ${item.lapCount ?? laps.length}`);
      laps.forEach((lap, index) => lines.push(`${index + 1}. ${formatClock(lap, true)}`));
      if (item.status !== "completed") lines.push(`Estado: ${activityStatusLabel(item.status)}`);
    } else if (item.type === "countdown") {
      lines.push(`Duración: ${formatClock(item.durationMs || 0)}`);
      lines.push(`Estado: ${activityStatusLabel(item.status)}`);
    } else if (item.type === "intervals") {
      const config = item.config || {};
      lines.push(`Warm-up: ${config.warmupSeconds || 0} s`);
      lines.push(`Work: ${config.workSeconds || 0} s`);
      lines.push(`Rest: ${config.restSeconds || 0} s`);
      lines.push(`Rondas: ${config.rounds || 0}`);
      lines.push(`Estado: ${activityStatusLabel(item.status)}`);
    }
    return lines;
  }

  function activitiesForExport(now = Date.now()) {
    const seen = new Set();
    return [...state.sessionHistory, ...currentActivitySnapshots(now)]
      .filter((item) => {
        if (!item?.id || seen.has(item.id)) return false;
        seen.add(item.id);
        return true;
      })
      .sort((a, b) => historyTime(a) - historyTime(b));
  }

  function blockSeriesSummary(block) {
    const events = Array.isArray(block.setEvents) ? block.setEvents : [];
    const added = events.filter((event) => event.type === "increment").length;
    const removed = events.filter((event) => event.type === "decrement").length;
    const resets = events.filter((event) => event.type === "reset").length;
    if (!events.length) return "Series: sin cambios en este bloque";
    return "Series: +" + added + " · correcciones -1: " + removed + " · resets: " + resets;
  }

  function sessionSummary() {
    if (!state.session.startedAt) {
      return [
        "TREINONANOGPT — SESIÓN",
        "La sesión todavía no fue iniciada.",
        "",
        "— Exportado desde TreinoNanoGpt"
      ].join(String.fromCharCode(10));
    }
    const now = Date.now();
    const start = new Date(state.session.startedAt);
    const date = new Intl.DateTimeFormat("es-AR", { dateStyle: "long" }).format(start);
    const activities = activitiesForExport(now);
    const lines = [
      "TREINONANOGPT — SESIÓN",
      `Fecha: ${date}`,
      `Inicio: ${realTime(state.session.startedAt)}`,
      `Fin: ${state.session.endedAt ? realTime(state.session.endedAt) : "En curso"}`,
      `Tiempo efectivo: ${formatClock(sessionEffectiveMs(now))}`,
      `Tiempo transcurrido: ${formatClock(sessionElapsedMs(now))}`,
      `Pausas: ${formatClock(sessionPauseMs(now))}`
    ];

    state.session.blocks.forEach((block) => {
      const blockActivities = activities.filter((item) => item.blockId === block.id);
      lines.push(
        "",
        `BLOQUE ${block.number}`,
        `Inicio: ${realTime(block.startedAt)}`,
        `Fin: ${block.endedAt ? realTime(block.endedAt) : block.status === "paused" ? "Pausado" : "En curso"}`,
        `Duración efectiva: ${formatClock(blockEffectiveMs(block, now))}`,
        `Pausas del bloque: ${formatClock(blockPausedMs(block, now))}`,
        blockSeriesSummary(block),
        "",
        "ACTIVIDAD"
      );
      if (blockActivities.length) {
        blockActivities.forEach((item, index) => {
          if (index > 0) lines.push("");
          lines.push(...activitySummaryLines(item));
        });
      } else {
        lines.push("(Sin actividad de timers)");
      }
    });

    lines.push("", `Series contadas (valor actual): ${state.sets}`, "", "NOTAS");
    if (state.notes.length) {
      state.notes.forEach((note) => {
        const block = blockById(note.blockId);
        const blockLabel = block ? ` | BLOQUE ${block.number}` : "";
        lines.push(`[${realTime(note.createdAt)}${blockLabel}] ${note.text}`);
      });
    }
    else lines.push("(Sin notas)");
    if (state.draft.trim()) lines.push("", `BORRADOR SIN AGREGAR: ${state.draft.trim()}`);
    lines.push("", "— Exportado desde TreinoNanoGpt");
    return lines.join(String.fromCharCode(10));
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
    confirmAction();
    releaseWakeLock();
    state = cloneDefaults();
    localStorage.removeItem(STORAGE_KEY);
    saveState(true);
    renderStatic();
    showToast("Nueva sesión preparada");
  }

  els.startSession.addEventListener("click", () => { confirmAction(); startSession(); });
  els.toggleBlock.addEventListener("click", () => { confirmAction(); toggleCurrentBlock(); });
  els.finishBlock.addEventListener("click", () => { confirmAction(); finishActiveBlock(); });
  els.nextBlock.addEventListener("click", () => { confirmAction(); startNextBlock(); });
  els.finishSession.addEventListener("click", () => { confirmAction(); finishCurrentSession(); });
  $$(".mode-tab").forEach((button) => button.addEventListener("click", () => {
    confirmAction();
    pauseOtherTimers(button.dataset.mode);
    state.mode = button.dataset.mode;
    saveState(true);
    syncWakeLock();
    renderStatic();
  }));
  els.toggleTimer.addEventListener("click", toggleCurrentTimer);
  els.resetTimer.addEventListener("click", resetCurrentTimer);
  els.lapTimer.addEventListener("click", async () => {
    if (state.stopwatch.status !== "running") return;
    await confirmAction();
    state.stopwatch.laps.push(getStopwatchElapsed());
    saveState(true);
    renderStatic();
  });
  [els.countdownMinutes, els.countdownSeconds, els.warmupSeconds, els.workSeconds, els.restSeconds, els.rounds].forEach((input) => input.addEventListener("change", updateConfigFromInputs));
  $("#incrementSet").addEventListener("click", () => {
    if (!hasCurrentBlock()) return;
    confirmAction();
    const before = state.sets;
    state.sets += 1;
    recordSetEvent("increment", before, state.sets);
    saveState(true);
    renderStatic();
  });
  $("#decrementSet").addEventListener("click", () => {
    if (!hasCurrentBlock() || state.sets === 0) return;
    confirmAction();
    const before = state.sets;
    state.sets = Math.max(0, state.sets - 1);
    recordSetEvent("decrement", before, state.sets);
    saveState(true);
    renderStatic();
  });
  $("#resetSets").addEventListener("click", () => {
    if (!hasCurrentBlock()) return;
    confirmAction();
    const before = state.sets;
    state.sets = 0;
    recordSetEvent("reset", before, state.sets);
    saveState(true);
    renderStatic();
  });
  els.noteInput.addEventListener("input", () => { state.draft = els.noteInput.value; saveState(); });
  els.noteInput.addEventListener("keydown", (event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") addNote(); });
  $("#addNote").addEventListener("click", addNote);
  $("#copySession").addEventListener("click", () => { confirmAction(); copySession(); });
  els.newSession.addEventListener("pointerdown", startHold);
  ["pointerup", "pointercancel", "pointerleave"].forEach((name) => els.newSession.addEventListener(name, cancelHold));
  els.newSession.addEventListener("keydown", startHold);
  els.newSession.addEventListener("keyup", cancelHold);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      reconcileIntervals(Date.now(), true);
      syncWakeLock();
      renderTimer();
      renderSession();
    } else {
      syncDisplayLoop();
      if (wakeLock) releaseWakeLock();
    }
  });
  window.addEventListener("pagehide", () => saveState(true));

  saveState(true);
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
