(() => {
  "use strict";

  const MODES = {
    pomodoro: {
      workMs: 25 * 60 * 1000,
      breakMs: 5 * 60 * 1000,
      warningSeconds: [10 * 60, 5 * 60]
    },
    hft: {
      workMs: 30 * 1000,
      breakMs: 10 * 1000,
      warningSeconds: [15]
    }
  };
  const STATE_KEY = "flow-timer-state-v2";
  const OLD_STATE_KEY = "flow-timer-state-v1";
  const SOUND_KEY = "flow-timer-sound-v1";

  const elements = {
    panel: document.getElementById("timer-panel"),
    content: document.getElementById("timer-content"),
    tabs: [...document.querySelectorAll(".mode-tab")],
    phaseText: document.getElementById("phase-text"),
    completedCount: document.getElementById("completed-count"),
    ring: document.getElementById("timer-ring"),
    time: document.getElementById("time-display"),
    countdown: document.getElementById("countdown-cue"),
    countdownNumber: document.getElementById("countdown-number"),
    start: document.getElementById("start-button"),
    startLabel: document.getElementById("start-label"),
    reset: document.getElementById("reset-button"),
    skip: document.getElementById("skip-button"),
    warningTimes: document.getElementById("warning-times"),
    soundToggle: document.getElementById("sound-toggle"),
    soundLabel: document.getElementById("sound-label"),
    testSound: document.getElementById("test-sound"),
    announcement: document.getElementById("announcement")
  };

  function freshState(mode) {
    return {
      mode,
      phase: "work",
      running: false,
      started: false,
      remainingMs: MODES[mode].workMs,
      endAt: null,
      completedSessions: 0
    };
  }

  function validateState(stored, mode) {
    if (!stored || stored.mode !== mode) return freshState(mode);
    if (stored.phase !== "work" && stored.phase !== "break") return freshState(mode);
    if (typeof stored.running !== "boolean") return freshState(mode);
    if (!Number.isFinite(stored.remainingMs) || stored.remainingMs < 0) return freshState(mode);
    if (stored.running && (!Number.isFinite(stored.endAt) || stored.endAt <= 0)) return freshState(mode);
    const duration = MODES[mode][stored.phase === "work" ? "workMs" : "breakMs"];
    return {
      mode,
      phase: stored.phase,
      running: stored.running,
      started: typeof stored.started === "boolean" ? stored.started :
        (stored.running || stored.remainingMs < duration || stored.phase === "break"),
      remainingMs: Math.min(stored.remainingMs, duration),
      endAt: stored.running ? stored.endAt : null,
      completedSessions: Number.isSafeInteger(stored.completedSessions) && stored.completedSessions >= 0
        ? stored.completedSessions : 0
    };
  }

  function loadState() {
    const states = { pomodoro: freshState("pomodoro"), hft: freshState("hft") };
    let selectedMode = "pomodoro";
    try {
      const stored = JSON.parse(localStorage.getItem(STATE_KEY));
      if (stored && stored.states) {
        for (const mode of Object.keys(MODES)) states[mode] = validateState(stored.states[mode], mode);
        if (Object.hasOwn(MODES, stored.selectedMode)) selectedMode = stored.selectedMode;
      } else {
        // 旧バージョンの実行状態を引き継ぐ
        const previous = JSON.parse(localStorage.getItem(OLD_STATE_KEY));
        if (previous && Object.hasOwn(MODES, previous.mode)) {
          selectedMode = previous.mode;
          states[selectedMode] = validateState(previous, selectedMode);
        }
      }
    } catch (_) {
      // 読み込めない保存状態は初期状態で開始
    }
    // 旧バージョンやデータ破損で両モードが動作中なら片方だけ残す
    const other = selectedMode === "pomodoro" ? "hft" : "pomodoro";
    if (states[selectedMode].running && states[other].running) states[other] = freshState(other);
    return { states, selectedMode };
  }

  function loadSoundSetting() {
    try {
      return localStorage.getItem(SOUND_KEY) !== "off";
    } catch (_) {
      return true;
    }
  }

  const stored = loadState();
  let states = stored.states;
  let selectedMode = stored.selectedMode;
  let soundOn = loadSoundSetting();
  let audioContext = null;
  let lastSnapshot = null;
  let lastAnnouncedPhase = `${selectedMode}:${states[selectedMode].phase}`;

  function persistState() {
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify({ selectedMode, states }));
    } catch (_) {
      // 保存できなくてもタイマーは継続
    }
  }

  function durationFor(state) {
    return MODES[state.mode][state.phase === "work" ? "workMs" : "breakMs"];
  }

  function remainingAt(now, state) {
    return state.running ? Math.max(0, state.endAt - now) : state.remainingMs;
  }

  function runningState() {
    return Object.values(states).find((state) => state.running) || null;
  }

  // 現在時刻から集中・休憩の周期を復元
  function advanceToNow(now, state) {
    if (!state || !state.running || now < state.endAt) return false;

    function advanceOnePhase() {
      if (state.phase === "work") state.completedSessions += 1;
      state.phase = state.phase === "work" ? "break" : "work";
      state.endAt += durationFor(state);
    }

    advanceOnePhase();
    const cycleMs = MODES[state.mode].workMs + MODES[state.mode].breakMs;
    const fullCycles = Math.floor(Math.max(0, now - state.endAt) / cycleMs);
    if (fullCycles > 0) {
      state.completedSessions += fullCycles;
      state.endAt += fullCycles * cycleMs;
    }
    while (now >= state.endAt) advanceOnePhase();
    state.remainingMs = Math.max(0, state.endAt - now);
    persistState();
    return true;
  }

  function snapshot(now, state) {
    if (!state) return null;
    return {
      mode: state.mode,
      phase: state.phase,
      running: state.running,
      endAt: state.endAt,
      remainingMs: remainingAt(now, state)
    };
  }

  function unlockAudio() {
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return null;
      if (!audioContext) audioContext = new AudioContextClass();
      return audioContext;
    } catch (_) {
      return null;
    }
  }

  function scheduleTone(context, start, frequency, duration, volume = 0.38) {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(frequency, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(volume, start + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(start);
    oscillator.stop(start + duration + 0.01);
  }

  function playSound(kind = "cue", force = false) {
    if (!soundOn && !force) return;
    if (document.visibilityState !== "visible") return;
    const context = unlockAudio();
    if (!context) return;
    const schedule = () => {
      if (context.state !== "running") return;
      const start = context.currentTime + 0.005;
      try {
        if (kind === "finish") {
          scheduleTone(context, start, 784, 0.16);
          scheduleTone(context, start + 0.20, 1046.5, 0.29);
        } else {
          scheduleTone(context, start, 880, 0.20);
        }
      } catch (_) {
        // 音声APIが使用できなくても表示を継続
      }
    };
    if (context.state === "suspended") {
      context.resume().then(schedule).catch(() => {});
    } else {
      schedule();
    }
  }

  // 非表示からの復帰直後に古い予告音を再生しない
  function playCrossedCues(before, after) {
    if (!before || !before.running || !after || !after.running) return;
    if (before.mode !== after.mode || before.phase !== after.phase || before.endAt !== after.endAt) return;
    const seconds = [...MODES[after.mode].warningSeconds.filter(() => after.phase === "work"), 3, 2, 1];
    for (const second of seconds) {
      const threshold = second * 1000;
      if (before.remainingMs > threshold && after.remainingMs <= threshold && threshold - after.remainingMs < 950) {
        playSound("cue");
        return;
      }
    }
  }

  function announce(message) {
    elements.announcement.textContent = message;
  }

  function formatTime(milliseconds) {
    const seconds = Math.ceil(Math.max(0, milliseconds) / 1000);
    const minutes = Math.floor(seconds / 60);
    return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  }

  function render(now = Date.now()) {
    const state = states[selectedMode];
    const remain = remainingAt(now, state);
    const total = durationFor(state);
    const seconds = Math.ceil(remain / 1000);
    const phaseName = state.phase === "work" ? "集中タイム" : "休憩タイム";

    elements.panel.dataset.phase = state.phase;
    elements.panel.dataset.mode = selectedMode;
    elements.phaseText.textContent = phaseName;
    elements.completedCount.textContent = state.completedSessions.toLocaleString("ja-JP");
    elements.time.textContent = formatTime(remain);
    elements.time.setAttribute("aria-label", `残り${Math.floor(seconds / 60)}分${seconds % 60}秒`);
    elements.ring.style.setProperty("--progress", `${((total - remain) / total * 100).toFixed(3)}%`);

    const showCountdown = state.running && seconds >= 1 && seconds <= 3;
    elements.countdown.hidden = !showCountdown;
    if (showCountdown) elements.countdownNumber.textContent = seconds;

    elements.start.dataset.running = String(state.running);
    elements.startLabel.textContent = state.running ? "一時停止" : state.started ? "再開する" : "開始する";
    elements.start.setAttribute("aria-label", elements.startLabel.textContent);
    elements.warningTimes.textContent = selectedMode === "pomodoro"
      ? "集中終了の10分前・5分前" : "集中終了の15秒前";
    elements.soundToggle.setAttribute("aria-pressed", String(soundOn));
    elements.soundLabel.textContent = soundOn ? "音 ON" : "音 OFF";

    for (const tab of elements.tabs) {
      const active = tab.dataset.mode === selectedMode;
      tab.classList.toggle("is-selected", active);
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
      if (active) elements.content.setAttribute("aria-labelledby", tab.id);
    }

    // タブを切り替えても、実際に計測中のモードをタイトルに表示
    const titleState = runningState() || (state.started ? state : null);
    document.title = titleState ? `${formatTime(remainingAt(now, titleState))} - Flow Timer` : "Flow Timer";

    const currentPhase = `${selectedMode}:${state.phase}`;
    if (lastAnnouncedPhase !== currentPhase) {
      lastAnnouncedPhase = currentPhase;
      announce(`${phaseName}に切り替わりました。`);
    }
  }

  function tick() {
    const now = Date.now();
    const before = lastSnapshot;
    const active = runningState();
    const didAdvance = advanceToNow(now, active);
    const after = snapshot(now, active);
    if (document.visibilityState === "visible") {
      if (didAdvance && before && before.running && before.mode === active.mode &&
          now - before.endAt < 1100 && now >= before.endAt) {
        playSound("finish");
      } else if (!didAdvance) {
        playCrossedCues(before, after);
      }
    }
    lastSnapshot = after;
    render(now);
  }

  function startOrPause() {
    const now = Date.now();
    const state = states[selectedMode];
    advanceToNow(now, runningState());
    if (state.running) {
      state.remainingMs = Math.max(0, state.endAt - now);
      state.running = false;
      state.endAt = null;
      announce("タイマーを一時停止しました。");
    } else {
      // 別モードはタブ切替時ではなく開始時にリセット
      const other = selectedMode === "pomodoro" ? "hft" : "pomodoro";
      states[other] = freshState(other);
      state.endAt = now + state.remainingMs;
      state.running = true;
      state.started = true;
      playSound("cue");
      announce("タイマーを開始しました。");
    }
    persistState();
    lastSnapshot = null;
    tick();
  }

  function resetTimer() {
    states[selectedMode] = freshState(selectedMode);
    persistState();
    lastSnapshot = null;
    lastAnnouncedPhase = `${selectedMode}:work`;
    tick();
    announce("タイマーをリセットしました。");
  }

  function skipPhase() {
    const now = Date.now();
    const state = states[selectedMode];
    advanceToNow(now, state);
    state.phase = state.phase === "work" ? "break" : "work";
    state.remainingMs = durationFor(state);
    state.endAt = state.running ? now + state.remainingMs : null;
    persistState();
    lastSnapshot = null;
    tick();
  }

  function switchMode(mode) {
    if (!Object.hasOwn(MODES, mode) || mode === selectedMode) return;
    selectedMode = mode;
    persistState();
    // タブ切替ではどちらのタイマーもリセット・一時停止しない
    tick();
    announce(`${mode === "pomodoro" ? "Pomodoro" : "HFT"}に切り替えました。`);
  }

  elements.start.addEventListener("click", startOrPause);
  elements.reset.addEventListener("click", resetTimer);
  elements.skip.addEventListener("click", skipPhase);
  for (const tab of elements.tabs) {
    tab.addEventListener("click", () => switchMode(tab.dataset.mode));
    tab.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const other = elements.tabs.find((candidate) => candidate !== tab);
      if (other) {
        switchMode(other.dataset.mode);
        other.focus();
      }
    });
  }
  elements.soundToggle.addEventListener("click", () => {
    soundOn = !soundOn;
    try {
      localStorage.setItem(SOUND_KEY, soundOn ? "on" : "off");
    } catch (_) {}
    if (soundOn) unlockAudio();
    render();
    announce(soundOn ? "音をオンにしました。" : "音をオフにしました。");
  });
  elements.testSound.addEventListener("click", () => playSound("cue", true));

  document.addEventListener("visibilitychange", () => {
    lastSnapshot = null;
    tick();
  });
  window.addEventListener("pageshow", () => {
    lastSnapshot = null;
    tick();
  });
  window.addEventListener("focus", () => {
    lastSnapshot = null;
    tick();
  });

  tick();
  window.setInterval(tick, 100);

  // Service Workerはオフライン利用用であり、バックグラウンド動作の保証ではない
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js", { scope: "./" }).catch(() => {});
    });
  }
})();
