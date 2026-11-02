'use strict';
/*
 * RenStep: a personal step tracker, workout log and rule-based coach.
 * Everything is stored on this device (localStorage). No network calls, no accounts.
 * Security notes: user text is only ever inserted with textContent (never innerHTML),
 * imported backups are validated field by field, and the CSP in index.html blocks
 * inline and third-party scripts.
 */

// ---------- small helpers ----------
const $ = (sel) => document.querySelector(sel);
const DAY_MS = 86400000;
const STORE_KEY = 'renstep.v1';

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : String(kid));
  }
  return el;
}

function svg(tag, attrs, ...kids) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, String(v));
  for (const kid of kids) {
    if (kid == null) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const pad = (n) => String(n).padStart(2, '0');
const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayKey = () => keyOf(new Date());
function dateOfKey(k) { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); }
function addDaysKey(k, n) { const d = dateOfKey(k); d.setDate(d.getDate() + n); return keyOf(d); }
const fmtInt = (n) => Math.round(n).toLocaleString('en-ZA');
const trimNum = (n) => (Math.round(n * 100) / 100).toString();
const fmtKg = (w) => (w > 0 ? `${trimNum(w)} kg` : 'Bodyweight');
const clampInt = (v, lo, hi, dflt) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt; };
const clampNum = (v, lo, hi, dflt) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt; };
const str = (v, max, dflt = '') => (typeof v === 'string' ? v.trim().slice(0, max) : dflt);
const isKey = (k) => typeof k === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(k) && !Number.isNaN(dateOfKey(k).getTime());
const isoOr = (v, d) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : d);
const fmtDate = (iso) => new Date(iso).toLocaleDateString('en-ZA', { weekday: 'short', day: 'numeric', month: 'short' });

function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), ms);
}

// ---------- state & storage ----------
function defaultState() {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    settings: { goalMode: 'auto', manualGoal: 8000, restSec: 90 },
    steps: {},
    routines: [],
    sessions: [],
    badges: [],
    activeWorkout: null,
    lastBackup: null,
    seeded: false,
  };
}

function normExercise(e) {
  if (!e || typeof e !== 'object') return null;
  const name = str(e.name, 60);
  if (!name) return null;
  const repLow = clampInt(e.repLow, 1, 100, 8);
  return {
    id: str(e.id, 64) || uid(),
    name,
    sets: clampInt(e.sets, 1, 12, 3),
    repLow,
    repHigh: Math.max(repLow, clampInt(e.repHigh, 1, 200, repLow + 4)),
    startWeight: clampNum(e.startWeight, 0, 1000, 0),
    increment: clampNum(e.increment, 0, 50, 2.5),
  };
}

function normSet(s) {
  if (!s || typeof s !== 'object') return null;
  const exercise = str(s.exercise, 60);
  if (!exercise) return null;
  return {
    exercise,
    order: clampInt(s.order, 0, 100, 0),
    idx: clampInt(s.idx, 0, 100, 0),
    reps: clampInt(s.reps, 0, 1000, 0),
    weight: clampNum(s.weight, 0, 2000, 0),
  };
}

function normActive(a) {
  if (!a || typeof a !== 'object' || !Array.isArray(a.exercises)) return null;
  return {
    routineId: str(a.routineId, 64),
    routineName: str(a.routineName, 60, 'Workout'),
    startedAt: isoOr(a.startedAt, new Date().toISOString()),
    exercises: a.exercises.slice(0, 30).map((e, i) => ({
      name: str(e && e.name, 60, `Exercise ${i + 1}`),
      order: i,
      target: {
        weight: clampNum(e && e.target && e.target.weight, 0, 1000, 0),
        reps: clampInt(e && e.target && e.target.reps, 0, 200, 8),
        sets: clampInt(e && e.target && e.target.sets, 1, 12, 3),
        note: str(e && e.target && e.target.note, 300),
      },
      sets: (Array.isArray(e && e.sets) ? e.sets : []).slice(0, 20).map((s) => ({
        weight: clampNum(s && s.weight, 0, 2000, 0),
        reps: clampInt(s && s.reps, 0, 1000, 0),
        done: !!(s && s.done),
      })),
    })),
  };
}

function normalize(raw) {
  const s = defaultState();
  if (!raw || typeof raw !== 'object') return s;
  s.createdAt = isoOr(raw.createdAt, s.createdAt);
  const st = raw.settings || {};
  s.settings.goalMode = st.goalMode === 'fixed' ? 'fixed' : 'auto';
  s.settings.manualGoal = clampInt(st.manualGoal, 1000, 50000, 8000);
  s.settings.restSec = clampInt(st.restSec, 0, 600, 90);
  if (raw.steps && typeof raw.steps === 'object') {
    for (const [k, v] of Object.entries(raw.steps)) if (isKey(k)) s.steps[k] = clampInt(v, 0, 200000, 0);
  }
  if (Array.isArray(raw.routines)) {
    s.routines = raw.routines.slice(0, 50).filter((r) => r && typeof r === 'object').map((r) => ({
      id: str(r.id, 64) || uid(),
      name: str(r.name, 60, 'Routine') || 'Routine',
      exercises: (Array.isArray(r.exercises) ? r.exercises : []).slice(0, 30).map(normExercise).filter(Boolean),
    }));
  }
  if (Array.isArray(raw.sessions)) {
    s.sessions = raw.sessions.slice(0, 10000).filter((x) => x && typeof x === 'object' && !Number.isNaN(Date.parse(x.date))).map((x) => ({
      id: str(x.id, 64) || uid(),
      date: new Date(x.date).toISOString(),
      routineName: str(x.routineName, 60, 'Workout') || 'Workout',
      durationMin: clampInt(x.durationMin, 0, 600, 0),
      xp: clampInt(x.xp, 0, 2000, 0),
      sets: (Array.isArray(x.sets) ? x.sets : []).slice(0, 300).map(normSet).filter(Boolean),
    }));
    s.sessions.sort((a, b) => a.date.localeCompare(b.date));
  }
  if (Array.isArray(raw.badges)) s.badges = raw.badges.filter((b) => BADGES.some((d) => d.id === b));
  s.activeWorkout = normActive(raw.activeWorkout);
  s.lastBackup = raw.lastBackup ? isoOr(raw.lastBackup, null) : null;
  s.seeded = !!raw.seeded;
  return s;
}

let data;
function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    data = raw ? normalize(JSON.parse(raw)) : defaultState();
  } catch (e) {
    console.error(e);
    data = defaultState();
    toast('Could not read saved data. Restore a backup in Settings if needed.', 5000);
  }
}
function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(data));
  } catch (e) {
    console.error(e);
    toast('Saving failed: storage may be full. Export a backup.', 5000);
  }
}

function seedIfNeeded() {
  if (data.seeded) return;
  const ex = (name, sets, repLow, repHigh, startWeight, increment) => ({ id: uid(), name, sets, repLow, repHigh, startWeight, increment });
  data.routines.push(
    { id: uid(), name: 'Upper Body', exercises: [
      ex('Bench Press', 3, 6, 10, 40, 2.5),
      ex('Bent-over Row', 3, 8, 12, 30, 2.5),
      ex('Overhead Press', 3, 6, 10, 25, 2.5),
      ex('Lat Pulldown', 3, 8, 12, 35, 2.5),
      ex('Bicep Curl', 2, 10, 15, 10, 1),
    ] },
    { id: uid(), name: 'Lower Body', exercises: [
      ex('Back Squat', 3, 6, 10, 50, 5),
      ex('Romanian Deadlift', 3, 8, 12, 40, 5),
      ex('Walking Lunge', 3, 8, 12, 10, 2),
      ex('Calf Raise', 3, 12, 20, 20, 5),
    ] },
    { id: uid(), name: 'Home Bodyweight', exercises: [
      ex('Push-up', 3, 8, 15, 0, 0),
      ex('Bodyweight Squat', 3, 12, 25, 0, 0),
      ex('Glute Bridge', 3, 10, 20, 0, 0),
      ex('Pike Push-up', 3, 6, 12, 0, 0),
    ] },
  );
  data.seeded = true;
  save();
}

// ---------- steps, goals, XP ----------
function stepGoalFor(key) {
  if (data.settings.goalMode === 'fixed') return data.settings.manualGoal;
  const prior = [];
  for (let i = 1; i <= 14; i++) {
    const v = data.steps[addDaysKey(key, -i)];
    if (v > 0) prior.push(v);
  }
  if (prior.length < 3) return data.settings.manualGoal;
  prior.sort((a, b) => a - b);
  const median = prior[Math.floor(prior.length / 2)];
  const target = Math.round((median * 1.1) / 500) * 500; // nudge 10% above your typical day
  return Math.min(15000, Math.max(5000, target));
}

function stepXP(steps, goal) { return Math.floor(steps / 1000) * 2 + (steps >= goal ? 25 : 0); }
const WORKOUT_BASE_XP = 50, XP_PER_SET = 2, XP_PER_PR = 10;
const levelFor = (xp) => Math.floor(Math.sqrt(xp / 100)) + 1;
const levelStartXP = (lvl) => 100 * (lvl - 1) * (lvl - 1);

function totals() {
  const today = todayKey();
  let stepTotal = 0;
  // Step XP is only counted for finished days, so today's number can still change.
  for (const [k, v] of Object.entries(data.steps)) if (k < today) stepTotal += stepXP(v, stepGoalFor(k));
  const workoutXP = data.sessions.reduce((a, s) => a + s.xp, 0);
  const xp = stepTotal + workoutXP;
  const level = levelFor(xp);
  const start = levelStartXP(level), next = levelStartXP(level + 1);
  return { xp, stepXP: stepTotal, workoutXP, level, start, next, progress: (xp - start) / (next - start) };
}

function workoutDayKeys() { return new Set(data.sessions.map((s) => keyOf(new Date(s.date)))); }

function isActiveDay(k, wdays) { return wdays.has(k) || (data.steps[k] || 0) >= stepGoalFor(k); }

function currentStreak() {
  const wdays = workoutDayKeys();
  let k = todayKey();
  if (!isActiveDay(k, wdays)) k = addDaysKey(k, -1); // today isn't over yet, so it can't break the streak
  let n = 0;
  while (isActiveDay(k, wdays) && n < 5000) { n++; k = addDaysKey(k, -1); }
  return n;
}

function bestStreak() {
  const wdays = workoutDayKeys();
  const keys = new Set([...Object.keys(data.steps), ...wdays]);
  let best = 0;
  for (const k of keys) {
    if (!isActiveDay(k, wdays) || isActiveDay(addDaysKey(k, -1), wdays)) continue; // only start at streak beginnings
    let n = 0, c = k;
    while (isActiveDay(c, wdays) && n < 5000) { n++; c = addDaysKey(c, 1); }
    best = Math.max(best, n);
  }
  return best;
}

// ---------- records ----------
function isBetter(set, best) {
  if (!best) return true;
  if (set.weight > best.weight) return true;
  return set.weight === best.weight && set.reps > best.reps;
}
function isPR(set, best) {
  // A PR is a heavier weight than ever before, or more reps on a bodyweight move.
  if (!best) return false;
  return set.weight > best.weight || (set.weight === 0 && best.weight === 0 && set.reps > best.reps);
}
function recordsFrom(sessions) {
  const best = {};
  let prEvents = 0;
  for (const s of [...sessions].sort((a, b) => a.date.localeCompare(b.date))) {
    for (const set of s.sets) {
      if (set.reps <= 0) continue;
      const b = best[set.exercise];
      if (isPR(set, b)) prEvents++;
      if (isBetter(set, b)) best[set.exercise] = { exercise: set.exercise, weight: set.weight, reps: set.reps, date: s.date };
    }
  }
  return { best, prEvents };
}

// ---------- badges ----------
const BADGES = [
  { id: 'first_workout', icon: '🏁', name: 'First Rep', how: 'Log a workout', test: (c) => c.workouts >= 1 },
  { id: 'workouts_10', icon: '💪', name: 'Regular', how: '10 workouts', test: (c) => c.workouts >= 10 },
  { id: 'workouts_50', icon: '🏋️', name: 'Iron Habit', how: '50 workouts', test: (c) => c.workouts >= 50 },
  { id: 'workouts_100', icon: '🦾', name: 'Centurion', how: '100 workouts', test: (c) => c.workouts >= 100 },
  { id: 'first_pr', icon: '📈', name: 'New Best', how: 'Set a personal record', test: (c) => c.prEvents >= 1 },
  { id: 'pr_25', icon: '🚀', name: 'Climber', how: '25 personal records', test: (c) => c.prEvents >= 25 },
  { id: 'steps_10k', icon: '👟', name: '10K Day', how: '10,000 steps in a day', test: (c) => c.bestDay >= 10000 },
  { id: 'steps_20k', icon: '🥾', name: 'Trekker', how: '20,000 steps in a day', test: (c) => c.bestDay >= 20000 },
  { id: 'steps_1m', icon: '🌍', name: 'Million', how: '1,000,000 total steps', test: (c) => c.totalSteps >= 1000000 },
  { id: 'streak_7', icon: '🔥', name: 'On Fire', how: '7-day streak', test: (c) => c.bestStreak >= 7 },
  { id: 'streak_30', icon: '☄️', name: 'Unbroken', how: '30-day streak', test: (c) => c.bestStreak >= 30 },
  { id: 'volume_10t', icon: '🧱', name: '10 Tonnes', how: 'Lift 10,000 kg total', test: (c) => c.volume >= 10000 },
  { id: 'level_5', icon: '⭐', name: 'Level 5', how: 'Reach level 5', test: (c) => c.level >= 5 },
  { id: 'level_10', icon: '🌟', name: 'Level 10', how: 'Reach level 10', test: (c) => c.level >= 10 },
  { id: 'level_20', icon: '👑', name: 'Level 20', how: 'Reach level 20', test: (c) => c.level >= 20 },
];

function badgeContext() {
  const t = totals();
  const stepVals = Object.values(data.steps);
  return {
    workouts: data.sessions.length,
    prEvents: recordsFrom(data.sessions).prEvents,
    bestDay: stepVals.length ? Math.max(...stepVals) : 0,
    totalSteps: stepVals.reduce((a, b) => a + b, 0),
    bestStreak: bestStreak(),
    volume: data.sessions.reduce((a, s) => a + s.sets.reduce((b, x) => b + x.reps * x.weight, 0), 0),
    level: t.level,
  };
}

// Badges stay unlocked once earned, even if the data that earned them is later deleted.
function syncBadges() {
  const c = badgeContext();
  const fresh = BADGES.filter((b) => !data.badges.includes(b.id) && b.test(c));
  if (fresh.length) { data.badges.push(...fresh.map((b) => b.id)); save(); }
  return fresh;
}

// ---------- coach ----------
const roundTo = (w, inc) => (inc > 0 ? Math.max(0, Math.round(w / inc) * inc) : w);

function historyFor(name) {
  // newest first, only sessions where this exercise was done
  const out = [];
  for (let i = data.sessions.length - 1; i >= 0; i--) {
    const sets = data.sessions[i].sets.filter((s) => s.exercise === name && s.reps > 0);
    if (sets.length) out.push(sets.sort((a, b) => a.idx - b.idx));
  }
  return out;
}

function coachTarget(ex) {
  const hist = historyFor(ex.name);
  const base = { sets: ex.sets };
  if (!hist.length) {
    return { ...base, weight: ex.startWeight, reps: ex.repLow,
      note: ex.startWeight > 0
        ? `First time. Start at ${fmtKg(ex.startWeight)} and adjust so the last rep is hard but clean.`
        : `First time. Aim for ${ex.repLow}-${ex.repHigh} clean reps per set.` };
  }
  const last = hist[0];
  const lastWeight = Math.max(...last.map((s) => s.weight));
  const working = last.filter((s) => s.weight === lastWeight);
  const minReps = Math.min(...working.map((s) => s.reps));
  const missed = (sets) => sets.length > 0 && Math.min(...sets.map((s) => s.reps)) < ex.repLow;
  const hitTop = working.length >= ex.sets && minReps >= ex.repHigh;

  if (ex.increment === 0 || lastWeight === 0) {
    const reps = hitTop ? minReps + 1 : Math.max(ex.repLow, minReps + 1);
    return { ...base, weight: lastWeight, reps,
      note: hitTop
        ? `You beat ${ex.repHigh} reps on every set. Go for ${reps}, or switch to a harder variation.`
        : `Last time your lowest set was ${minReps}. Aim for ${reps} on every set.` };
  }
  if (hitTop) {
    const w = roundTo(lastWeight + ex.increment, ex.increment);
    return { ...base, weight: w, reps: ex.repLow,
      note: `You hit ${ex.repHigh}+ reps on all sets. Add ${trimNum(ex.increment)} kg and build back up from ${ex.repLow}.` };
  }
  if (missed(last) && hist[1] && missed(hist[1])) {
    const w = roundTo(lastWeight * 0.9, ex.increment);
    return { ...base, weight: w, reps: ex.repLow,
      note: `Two tough sessions in a row. Drop about 10% to ${fmtKg(w)}, nail your form and rebuild.` };
  }
  if (missed(last)) {
    return { ...base, weight: lastWeight, reps: ex.repLow,
      note: `Stay at ${fmtKg(lastWeight)}. Get at least ${ex.repLow} reps on every set before adding weight.` };
  }
  const reps = Math.min(ex.repHigh, minReps + 1);
  return { ...base, weight: lastWeight, reps,
    note: `Same weight, one more rep. Aim for ${reps} on every set. At ${ex.repHigh} you'll move up.` };
}

function dailyTip() {
  const now = new Date();
  const today = todayKey();
  const steps = data.steps[today];
  const goal = stepGoalFor(today);
  const last = data.sessions[data.sessions.length - 1];
  const daysSince = last ? Math.floor((dateOfKey(today) - dateOfKey(keyOf(new Date(last.date)))) / DAY_MS) : null;
  const streak = currentStreak();
  const tips = [];
  if (daysSince === 0) tips.push('Workout done today. Recovery is where you get stronger: aim for 7+ hours of sleep and protein with every meal.');
  else if (daysSince === null) tips.push('Start with one of the ready-made routines in Train. I\'ll set your targets from there.');
  else if (daysSince >= 4) tips.push(`It's been ${daysSince} days since your last workout. A short session today beats a perfect one next week.`);
  else if (daysSince >= 2) tips.push('You\'re rested. Today is a good day to train.');
  if (steps == null) tips.push('No steps logged today yet. Run your RenStep Steps shortcut, then tap Add steps.');
  else if (steps >= goal) tips.push(`Step goal smashed: ${fmtInt(steps)} steps.`);
  else if (now.getHours() >= 17) tips.push(`You're ${fmtInt(goal - steps)} steps short. A brisk 15-minute walk covers about 1,800.`);
  else tips.push(`${fmtInt(goal - steps)} steps to go today.`);
  if (streak >= 3 && !isActiveDay(today, workoutDayKeys())) tips.push(`Keep your ${streak}-day streak alive: hit your step goal or log a workout today.`);
  return tips.slice(0, 2).join(' ');
}

function nextRoutine() {
  if (!data.routines.length) return null;
  const last = data.sessions[data.sessions.length - 1];
  if (!last) return data.routines[0];
  const i = data.routines.findIndex((r) => r.name === last.routineName);
  return data.routines[(i + 1) % data.routines.length];
}

// ---------- rest timer ----------
const rest = { end: 0, timer: null };
function startRest(sec) {
  if (!sec) return;
  rest.end = Date.now() + sec * 1000;
  clearInterval(rest.timer);
  rest.timer = setInterval(drawRest, 500);
  drawRest();
}
function stopRest() { clearInterval(rest.timer); rest.timer = null; $('#restTimer').classList.add('hidden'); }
function drawRest() {
  const el = $('#restTimer');
  const left = Math.ceil((rest.end - Date.now()) / 1000);
  if (left <= -3) return stopRest();
  el.classList.remove('hidden');
  el.replaceChildren(
    h('span', null, left > 0 ? `Rest ${Math.floor(left / 60)}:${pad(left % 60)}` : 'Go! Next set'),
    h('button', { onclick: () => { rest.end += 15000; drawRest(); } }, '+15s'),
    h('button', { onclick: stopRest }, 'Skip'),
  );
}

// ---------- navigation ----------
const ui = { tab: 'today', routineId: null };
const TITLES = { today: 'Today', train: 'Train', history: 'History', rewards: 'Rewards' };

function go(tab, opts = {}) {
  ui.tab = tab;
  ui.routineId = opts.routineId || null;
  render();
  window.scrollTo(0, 0);
}

function render() {
  const keepScroll = window.scrollY;
  document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === ui.tab));
  let title = TITLES[ui.tab];
  let view;
  if (ui.tab === 'today') view = viewToday();
  else if (ui.tab === 'train') {
    if (data.activeWorkout) { view = viewWorkout(); title = 'Workout'; }
    else if (ui.routineId && data.routines.some((r) => r.id === ui.routineId)) { view = viewRoutine(ui.routineId); }
    else view = viewRoutines();
  } else if (ui.tab === 'history') view = viewHistory();
  else view = viewRewards();
  $('#title').textContent = title;
  $('#view').replaceChildren(view);
  window.scrollTo(0, keepScroll);
}

// ---------- views: Today ----------
function stepRing(steps, goal) {
  const r = 56, c = 2 * Math.PI * r;
  const p = Math.min(1, steps / goal);
  return svg('svg', { class: 'ring', viewBox: '0 0 132 132', role: 'img', 'aria-label': `${steps} of ${goal} steps` },
    svg('circle', { class: 'track', cx: 66, cy: 66, r, fill: 'none', 'stroke-width': 12 }),
    svg('circle', { class: 'fill', cx: 66, cy: 66, r, fill: 'none', 'stroke-width': 12,
      'stroke-dasharray': c, 'stroke-dashoffset': c * (1 - p), transform: 'rotate(-90 66 66)' }),
    svg('text', { x: 66, y: 62, 'text-anchor': 'middle', 'font-size': 26, 'font-weight': 800 }, `${Math.round(p * 100)}%`),
    svg('text', { x: 66, y: 82, 'text-anchor': 'middle', 'font-size': 12, fill: '#9aa0ab' }, 'of goal'),
  );
}

function weekChart() {
  const W = 340, H = 150, top = 14, bottom = 22;
  const keys = Array.from({ length: 7 }, (_, i) => addDaysKey(todayKey(), i - 6));
  const vals = keys.map((k) => data.steps[k] || 0);
  const goals = keys.map(stepGoalFor);
  const max = Math.max(...vals, ...goals, 1000) * 1.08;
  const y = (v) => top + (H - top - bottom) * (1 - v / max);
  const bw = W / 7;
  const g = svg('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Steps over the last 7 days' });
  keys.forEach((k, i) => {
    const v = vals[i];
    const bh = Math.max(2, (H - top - bottom) - (y(v) - top));
    g.append(svg('rect', { class: v >= goals[i] ? 'bar hit' : 'bar', x: i * bw + 8, y: H - bottom - bh, width: bw - 16, height: bh, rx: 5 }));
    g.append(svg('text', { x: i * bw + bw / 2, y: H - 6, 'text-anchor': 'middle' }, dateOfKey(k).toLocaleDateString('en-ZA', { weekday: 'narrow' })));
  });
  const gy = y(goals[6]);
  g.append(svg('line', { class: 'goal', x1: 0, x2: W, y1: gy, y2: gy, 'stroke-width': 1.5 }));
  return g;
}

function levelCard(t, streak) {
  return h('div', { class: 'card' },
    h('div', { class: 'row' },
      h('div', { class: 'level-badge', 'aria-label': `Level ${t.level}` }, String(t.level)),
      h('div', { class: 'grow' },
        h('div', { class: 'row between' },
          h('strong', null, `Level ${t.level}`),
          h('span', { class: streak > 0 ? 'pill fire' : 'pill' }, streak > 0 ? `🔥 ${streak}-day streak` : 'No streak yet')),
        h('div', { class: 'xpbar', style: null }, xpFill(t.progress)),
        h('div', { class: 'small muted' }, `${fmtInt(t.next - t.xp)} XP to level ${t.level + 1} · ${fmtInt(t.xp)} XP total`),
      )));
}
function xpFill(p) { const d = h('div'); d.style.width = `${Math.max(2, Math.round(p * 100))}%`; return d; }

function viewToday() {
  const k = todayKey();
  const steps = data.steps[k] || 0;
  const goal = stepGoalFor(k);
  const t = totals();
  const streak = currentStreak();
  const nr = nextRoutine();
  const backupDays = data.lastBackup ? Math.floor((Date.now() - Date.parse(data.lastBackup)) / DAY_MS) : null;
  const needsBackup = (data.sessions.length > 0 || Object.keys(data.steps).length > 3) && (backupDays === null || backupDays >= 14);

  return h('div', null,
    h('div', { class: 'card' },
      h('div', { class: 'ring-wrap' },
        stepRing(steps, goal),
        h('div', { class: 'grow' },
          h('div', { class: 'big-num' }, fmtInt(steps)),
          h('div', { class: 'muted small' }, `steps of ${fmtInt(goal)} goal`, data.settings.goalMode === 'auto' ? ' (auto)' : ''),
          h('div', { class: 'row', style: null },
            h('button', { class: 'btn primary sm', onclick: () => openStepsSheet() }, '+ Add steps'))))),
    h('div', { class: 'card coach' },
      h('div', { class: 'who' }, 'Coach'),
      h('div', null, dailyTip())),
    levelCard(t, streak),
    nr && !data.activeWorkout ? h('div', { class: 'card' },
      h('div', { class: 'row between' },
        h('div', null, h('div', { class: 'small muted' }, 'Up next'), h('strong', null, nr.name)),
        h('button', { class: 'btn primary sm', onclick: () => startWorkout(nr.id) }, 'Start'))) : null,
    data.activeWorkout ? h('div', { class: 'card' },
      h('div', { class: 'row between' },
        h('div', null, h('div', { class: 'small muted' }, 'In progress'), h('strong', null, data.activeWorkout.routineName)),
        h('button', { class: 'btn warm sm', onclick: () => go('train') }, 'Resume'))) : null,
    h('div', { class: 'card' },
      h('h2', null, 'Last 7 days'),
      weekChart(),
      h('div', { class: 'small muted' }, 'Green bars hit the goal. The dashed line is today\'s goal.')),
    needsBackup ? h('div', { class: 'card' },
      h('div', { class: 'row between' },
        h('div', { class: 'small' }, backupDays === null ? 'You haven\'t backed up yet.' : `Last backup was ${backupDays} days ago.`),
        h('button', { class: 'btn sm', onclick: exportBackup }, 'Back up'))) : null,
  );
}

// ---------- views: Train ----------
function viewRoutines() {
  return h('div', null,
    data.routines.length ? h('div', { class: 'list' },
      data.routines.map((r) => h('button', { class: 'list-item', onclick: () => go('train', { routineId: r.id }) },
        h('div', { class: 'grow' },
          h('strong', null, r.name),
          h('div', { class: 'small muted' }, `${r.exercises.length} exercise${r.exercises.length === 1 ? '' : 's'}`)),
        h('span', { class: 'chev' }, '›')))) : h('div', { class: 'empty' }, 'No routines yet.'),
    h('button', { class: 'btn block', onclick: () => openRoutineEditor(null) }, '+ New routine'),
  );
}

function viewRoutine(id) {
  const r = data.routines.find((x) => x.id === id);
  return h('div', null,
    h('button', { class: 'btn sm', onclick: () => go('train') }, '‹ Routines'),
    h('h2', { class: 'section-label' }, r.name),
    r.exercises.length ? r.exercises.map((ex) => {
      const t = coachTarget(ex);
      return h('div', { class: 'card' },
        h('div', { class: 'row between' }, h('h3', null, ex.name), h('span', { class: 'target' }, `${t.sets} × ${t.reps} @ ${fmtKg(t.weight)}`)),
        h('div', { class: 'small muted' }, t.note));
    }) : h('div', { class: 'empty' }, 'Add exercises with Edit.'),
    h('div', { class: 'stack' },
      h('button', { class: 'btn primary block', disabled: !r.exercises.length, onclick: () => startWorkout(r.id) }, 'Start workout'),
      h('button', { class: 'btn block', onclick: () => openRoutineEditor(r) }, 'Edit routine'),
      h('button', { class: 'btn danger block', onclick: () => {
        if (confirm(`Delete the routine "${r.name}"? Your workout history is kept.`)) {
          data.routines = data.routines.filter((x) => x.id !== r.id); save(); go('train');
        } } }, 'Delete routine')),
  );
}

function startWorkout(routineId) {
  const r = data.routines.find((x) => x.id === routineId);
  if (!r || !r.exercises.length) return;
  if (data.activeWorkout && !confirm('You already have a workout in progress. Replace it?')) return;
  data.activeWorkout = {
    routineId: r.id, routineName: r.name, startedAt: new Date().toISOString(),
    exercises: r.exercises.map((ex, i) => {
      const t = coachTarget(ex);
      return { name: ex.name, order: i, target: t,
        sets: Array.from({ length: t.sets }, () => ({ weight: t.weight, reps: t.reps, done: false })) };
    }),
  };
  save();
  go('train');
}

function viewWorkout() {
  const w = data.activeWorkout;
  const doneCount = w.exercises.reduce((a, e) => a + e.sets.filter((s) => s.done).length, 0);
  const started = new Date(w.startedAt);
  return h('div', null,
    h('div', { class: 'card' },
      h('div', { class: 'row between' },
        h('div', null, h('strong', null, w.routineName), h('div', { class: 'small muted' }, `Started ${started.toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' })} · ${doneCount} sets done`)),
      )),
    w.exercises.map((e, ei) => h('div', { class: 'card ex-card' },
      h('div', { class: 'row between' }, h('h3', null, e.name), h('span', { class: 'target' }, `${e.target.reps} @ ${fmtKg(e.target.weight)}`)),
      e.target.note ? h('div', { class: 'small muted' }, e.target.note) : null,
      h('div', { class: 'set-row set-head' }, h('span', { class: 'center' }, 'Set'), h('span', { class: 'center' }, 'kg'), h('span', { class: 'center' }, 'Reps'), h('span')),
      e.sets.map((s, si) => setRow(ei, si, s)),
      h('div', { class: 'row' },
        h('button', { class: 'btn sm', onclick: () => {
          const prev = e.sets[e.sets.length - 1] || { weight: e.target.weight, reps: e.target.reps };
          e.sets.push({ weight: prev.weight, reps: prev.reps, done: false }); save(); render();
        } }, '+ Add set'),
        e.sets.length > 1 ? h('button', { class: 'btn sm', onclick: () => { e.sets.pop(); save(); render(); } }, '− Remove set') : null),
    )),
    h('div', { class: 'stack' },
      h('button', { class: 'btn primary block', onclick: finishWorkout }, 'Finish workout'),
      h('button', { class: 'btn danger block', onclick: () => {
        if (confirm('Discard this workout? Nothing will be saved.')) { data.activeWorkout = null; stopRest(); save(); go('train'); }
      } }, 'Discard workout')),
  );
}

function setRow(ei, si, s) {
  const w = data.activeWorkout;
  const upd = (field, parse) => (ev) => { w.exercises[ei].sets[si][field] = parse(ev.target.value); save(); };
  return h('div', { class: s.done ? 'set-row done' : 'set-row' },
    h('span', { class: 'idx' }, String(si + 1)),
    h('input', { type: 'text', inputmode: 'decimal', value: trimNum(s.weight), 'aria-label': `Set ${si + 1} weight in kg`,
      oninput: upd('weight', (v) => clampNum(String(v).replace(',', '.'), 0, 2000, 0)) }),
    h('input', { type: 'text', inputmode: 'numeric', value: String(s.reps), 'aria-label': `Set ${si + 1} reps`,
      oninput: upd('reps', (v) => clampInt(v, 0, 1000, 0)) }),
    h('button', { class: s.done ? 'check done' : 'check', 'aria-label': s.done ? 'Mark set not done' : 'Mark set done', 'aria-pressed': s.done ? 'true' : 'false',
      onclick: () => {
        const set = w.exercises[ei].sets[si];
        set.done = !set.done;
        save();
        if (set.done) startRest(data.settings.restSec);
        render();
      } }, '✓'),
  );
}

function finishWorkout() {
  const w = data.activeWorkout;
  const sets = [];
  w.exercises.forEach((e) => e.sets.forEach((s, i) => {
    if (s.done && s.reps > 0) sets.push({ exercise: e.name, order: e.order, idx: i, reps: s.reps, weight: s.weight });
  }));
  if (!sets.length) { toast('Tick at least one set before finishing.'); return; }

  const before = totals();
  const { best } = recordsFrom(data.sessions);
  const prs = [];
  const running = { ...best };
  for (const s of sets) {
    if (isPR(s, running[s.exercise])) prs.push(`${s.exercise}: ${s.weight > 0 ? fmtKg(s.weight) + ' × ' + s.reps : s.reps + ' reps'}`);
    if (isBetter(s, running[s.exercise])) running[s.exercise] = { weight: s.weight, reps: s.reps };
  }
  const xp = WORKOUT_BASE_XP + sets.length * XP_PER_SET + prs.length * XP_PER_PR;
  const durationMin = Math.max(1, Math.round((Date.now() - Date.parse(w.startedAt)) / 60000));
  data.sessions.push({ id: uid(), date: w.startedAt, routineName: w.routineName, durationMin: Math.min(durationMin, 600), xp, sets });
  data.activeWorkout = null;
  stopRest();
  save();
  const after = totals();
  const newBadges = syncBadges();
  ui.routineId = null;
  render();
  openSheet('Workout complete', () => h('div', { class: 'stack' },
    h('div', { class: 'celebrate' }, after.level > before.level ? '🎉' : '💪'),
    h('div', { class: 'center' }, h('div', { class: 'big-num' }, `+${xp} XP`),
      h('div', { class: 'muted small' }, `${sets.length} sets · ${durationMin} min`)),
    after.level > before.level ? h('div', { class: 'card center' }, h('strong', null, `Level up! You're now level ${after.level}.`)) : null,
    prs.length ? h('div', { class: 'card' }, h('h2', null, `Personal records (+${prs.length * XP_PER_PR} XP)`), prs.map((p) => h('div', null, `📈 ${p}`))) : null,
    newBadges.length ? h('div', { class: 'card' }, h('h2', null, 'New badges'), newBadges.map((b) => h('div', null, `${b.icon} ${b.name}`))) : null,
    h('div', { class: 'card coach' }, h('div', { class: 'who' }, 'Coach'), h('div', null,
      prs.length ? 'New bests today. Your targets for next time are already updated.' : 'Solid work. Next session\'s targets are updated from what you just did.')),
  ));
}

// ---------- routine editor ----------
function openRoutineEditor(routine) {
  const draft = {
    name: routine ? routine.name : '',
    exercises: routine ? routine.exercises.map((e) => ({ ...e })) : [{ id: uid(), name: '', sets: 3, repLow: 8, repHigh: 12, startWeight: 20, increment: 2.5 }],
  };
  const body = () => {
    const field = (label, ex, key, mode) => h('label', { class: 'field' }, label,
      h('input', { type: 'text', inputmode: mode, value: key === 'name' ? ex[key] : trimNum(ex[key]),
        oninput: (ev) => { ex[key] = key === 'name' ? ev.target.value : String(ev.target.value).replace(',', '.'); } }));
    return h('div', { class: 'stack' },
      h('label', { class: 'field' }, 'Routine name',
        h('input', { type: 'text', value: draft.name, maxlength: 60, placeholder: 'e.g. Push Day', oninput: (ev) => { draft.name = ev.target.value; } })),
      draft.exercises.map((ex, i) => h('div', { class: 'card stack' },
        h('div', { class: 'row between' }, h('strong', null, `Exercise ${i + 1}`),
          h('button', { class: 'btn danger sm', onclick: () => { draft.exercises.splice(i, 1); rerender(); } }, 'Remove')),
        field('Name', ex, 'name'),
        h('div', { class: 'grid3' }, field('Sets', ex, 'sets', 'numeric'), field('Min reps', ex, 'repLow', 'numeric'), field('Max reps', ex, 'repHigh', 'numeric')),
        h('div', { class: 'grid2' }, field('Start weight (kg, 0 = bodyweight)', ex, 'startWeight', 'decimal'), field('Add per step (kg)', ex, 'increment', 'decimal')),
      )),
      h('button', { class: 'btn block', onclick: () => {
        draft.exercises.push({ id: uid(), name: '', sets: 3, repLow: 8, repHigh: 12, startWeight: 20, increment: 2.5 }); rerender();
      } }, '+ Add exercise'),
      h('button', { class: 'btn primary block', onclick: saveRoutine }, 'Save routine'),
      h('div', { class: 'small muted' }, 'The coach keeps you at a weight until you hit max reps on every set, then adds the step amount.'),
    );
  };
  const saveRoutine = () => {
    const name = str(draft.name, 60);
    if (!name) { toast('Give the routine a name.'); return; }
    const exercises = draft.exercises.map(normExercise).filter(Boolean);
    if (routine) { routine.name = name; routine.exercises = exercises; }
    else data.routines.push({ id: uid(), name, exercises });
    save();
    closeSheet();
    go('train', { routineId: routine ? routine.id : data.routines[data.routines.length - 1].id });
  };
  const { rerender } = openSheet(routine ? 'Edit routine' : 'New routine', body);
}

// ---------- steps entry ----------
function parseStepsText(text) {
  // Accepts the Shortcut output like "RENSTEP 2026-11-02 8 432" or just a number.
  const t = String(text || '').replace(/[  ]/g, ' ').trim();
  const dm = t.match(/(\d{4}-\d{2}-\d{2})/);
  const date = dm && isKey(dm[1]) ? dm[1] : null;
  const rest = (dm ? t.replace(dm[1], ' ') : t);
  const nm = rest.match(/\d[\d ,.]*/);
  if (!nm) return null;
  let raw = nm[0].trim().replace(/ /g, '');
  // "8432.0" or "8432,5" -> decimals; "8,432" or "8.432" -> thousands separators
  const dec = raw.match(/^(\d+)[.,](\d{1,2})$/);
  const n = dec ? Math.round(Number(`${dec[1]}.${dec[2]}`)) : Number(raw.replace(/[.,]/g, ''));
  if (!Number.isFinite(n) || n < 0 || n > 200000) return null;
  return { date, steps: n };
}

function recordSteps(date, steps) {
  const prev = data.steps[date];
  data.steps[date] = steps;
  save();
  const fresh = syncBadges();
  render();
  toast(`${fmtInt(steps)} steps saved for ${date === todayKey() ? 'today' : fmtDate(dateOfKey(date).toISOString())}${prev != null && prev !== steps ? ` (was ${fmtInt(prev)})` : ''}`);
  if (fresh.length) setTimeout(() => toast(`Badge unlocked: ${fresh.map((b) => `${b.icon} ${b.name}`).join(', ')}`, 4000), 2700);
}

function openStepsSheet() {
  const state = { date: todayKey(), value: data.steps[todayKey()] != null ? String(data.steps[todayKey()]) : '' };
  const body = () => h('div', { class: 'stack' },
    h('button', { class: 'btn primary block', onclick: async () => {
      try {
        const text = await navigator.clipboard.readText();
        const parsed = parseStepsText(text);
        if (!parsed) { toast('No step count found on the clipboard. Run the Shortcut first.'); return; }
        closeSheet();
        recordSteps(parsed.date || todayKey(), parsed.steps);
      } catch (e) {
        toast('Paste was blocked. Long-press the box below and choose Paste instead.', 4000);
      }
    } }, '📋 Paste from Shortcut'),
    h('div', { class: 'small muted center' }, 'or enter it yourself'),
    h('div', { class: 'grid2' },
      h('label', { class: 'field' }, 'Date', h('input', { type: 'date', value: state.date, max: todayKey(), oninput: (ev) => { state.date = ev.target.value; } })),
      h('label', { class: 'field' }, 'Steps', h('input', { type: 'text', inputmode: 'numeric', value: state.value, placeholder: 'e.g. 8432', oninput: (ev) => { state.value = ev.target.value; } }))),
    h('button', { class: 'btn block', onclick: () => {
      const parsed = parseStepsText(state.value);
      if (!isKey(state.date) || state.date > todayKey()) { toast('Pick a valid date (not in the future).'); return; }
      if (!parsed) { toast('Enter a step count between 0 and 200,000.'); return; }
      closeSheet();
      recordSteps(state.date, parsed.steps);
    } }, 'Save'),
    h('div', { class: 'small muted' }, 'Entering a day again replaces that day\'s number, so syncing more than once a day is fine.'),
  );
  openSheet('Add steps', body);
}

// ---------- history ----------
function viewHistory() {
  const { best } = recordsFrom(data.sessions);
  const recs = Object.values(best).sort((a, b) => b.date.localeCompare(a.date));
  const sessions = [...data.sessions].reverse();
  let month = '';
  const items = [];
  for (const s of sessions) {
    const m = new Date(s.date).toLocaleDateString('en-ZA', { month: 'long', year: 'numeric' });
    if (m !== month) { month = m; items.push(h('div', { class: 'section-label' }, m)); items.push(h('div', { class: 'list' })); }
    const vol = s.sets.reduce((a, x) => a + x.reps * x.weight, 0);
    items[items.length - 1].append(h('button', { class: 'list-item', onclick: () => openSession(s.id) },
      h('div', { class: 'grow' }, h('strong', null, s.routineName),
        h('div', { class: 'small muted' }, `${fmtDate(s.date)} · ${s.sets.length} sets${vol > 0 ? ` · ${fmtInt(vol)} kg` : ''} · +${s.xp} XP`)),
      h('span', { class: 'chev' }, '›')));
  }
  return h('div', null,
    recs.length ? h('div', null, h('div', { class: 'section-label' }, 'Personal records'),
      h('div', { class: 'list' }, recs.slice(0, 12).map((r) => h('div', { class: 'list-item' },
        h('div', { class: 'grow' }, h('strong', null, r.exercise), h('div', { class: 'small muted' }, fmtDate(r.date))),
        h('span', { class: 'target' }, r.weight > 0 ? `${fmtKg(r.weight)} × ${r.reps}` : `${r.reps} reps`))))) : null,
    items.length ? items : h('div', { class: 'empty' }, 'No workouts yet. Your history will show up here.'),
  );
}

function openSession(id) {
  const s = data.sessions.find((x) => x.id === id);
  if (!s) return;
  const groups = {};
  for (const set of s.sets) (groups[set.exercise] = groups[set.exercise] || { order: set.order, sets: [] }).sets.push(set);
  const ordered = Object.entries(groups).sort((a, b) => a[1].order - b[1].order);
  openSheet(s.routineName, () => h('div', { class: 'stack' },
    h('div', { class: 'muted small' }, `${fmtDate(s.date)} · ${s.durationMin} min · +${s.xp} XP`),
    ordered.map(([name, g]) => h('div', { class: 'card' }, h('h3', null, name),
      g.sets.sort((a, b) => a.idx - b.idx).map((x, i) => h('div', { class: 'row between small' },
        h('span', { class: 'muted' }, `Set ${i + 1}`), h('span', null, x.weight > 0 ? `${fmtKg(x.weight)} × ${x.reps}` : `${x.reps} reps`))))),
    h('button', { class: 'btn danger block', onclick: () => {
      if (confirm('Delete this workout from your history? Its XP will be removed (badges stay).')) {
        data.sessions = data.sessions.filter((x) => x.id !== id); save(); closeSheet(); render();
      } } }, 'Delete workout'),
  ));
}

// ---------- rewards ----------
function viewRewards() {
  const t = totals();
  const c = badgeContext();
  const streak = currentStreak();
  const stat = (label, value) => h('div', { class: 'card center' }, h('div', { class: 'big-num' }, value), h('div', { class: 'small muted' }, label));
  return h('div', null,
    levelCard(t, streak),
    h('div', { class: 'grid2' },
      stat('Workouts', fmtInt(c.workouts)),
      stat('Best streak', `${c.bestStreak}d`),
      stat('Best step day', fmtInt(c.bestDay)),
      stat('Kg lifted', fmtInt(c.volume))),
    h('div', { class: 'section-label' }, `Badges · ${data.badges.length}/${BADGES.length}`),
    h('div', { class: 'badges' }, BADGES.map((b) => {
      const got = data.badges.includes(b.id);
      return h('div', { class: got ? 'badge' : 'badge locked', 'aria-label': `${b.name}: ${got ? 'unlocked' : 'locked'}. ${b.how}` },
        h('div', { class: 'icon' }, b.icon), h('div', { class: 'name' }, b.name), h('div', { class: 'how' }, b.how));
    })),
    h('div', { class: 'card small muted' },
      h('strong', null, 'How XP works'), h('br'),
      `Workout: ${WORKOUT_BASE_XP} XP + ${XP_PER_SET} per set + ${XP_PER_PR} per personal record. `,
      'Steps: 2 XP per 1,000 steps, plus 25 XP when you hit your goal (counted once the day is over). ',
      'A streak day is any day you hit your step goal or log a workout.'),
  );
}

// ---------- settings, backup ----------
function openSettings() {
  const st = data.settings;
  openSheet('Settings', () => h('div', { class: 'stack' },
    h('div', { class: 'card stack' },
      h('h2', null, 'Step goal'),
      h('label', { class: 'field' }, 'Goal type',
        h('select', { onchange: (ev) => { st.goalMode = ev.target.value === 'fixed' ? 'fixed' : 'auto'; save(); render(); } },
          h('option', { value: 'auto', selected: st.goalMode === 'auto' }, 'Auto: 10% above my usual'),
          h('option', { value: 'fixed', selected: st.goalMode === 'fixed' }, 'Fixed number'))),
      h('label', { class: 'field' }, st.goalMode === 'fixed' ? 'Daily goal' : 'Starting goal (used until you have 3 days logged)',
        h('input', { type: 'text', inputmode: 'numeric', value: String(st.manualGoal),
          onchange: (ev) => { st.manualGoal = clampInt(ev.target.value, 1000, 50000, 8000); ev.target.value = String(st.manualGoal); save(); render(); } })),
      h('label', { class: 'field' }, 'Rest timer between sets (seconds, 0 = off)',
        h('input', { type: 'text', inputmode: 'numeric', value: String(st.restSec),
          onchange: (ev) => { st.restSec = clampInt(ev.target.value, 0, 600, 90); ev.target.value = String(st.restSec); save(); } }))),
    h('div', { class: 'card stack' },
      h('h2', null, 'Steps from Apple Health'),
      h('div', { class: 'small' }, 'Make this Shortcut once in the Shortcuts app:'),
      h('ol', { class: 'steps small' },
        h('li', null, 'New Shortcut, name it ', h('code', null, 'RenStep Steps'), '.'),
        h('li', null, 'Add ', h('strong', null, 'Find Health Samples'), ': Type is Steps, Start Date is today. Turn on Group By Day.'),
        h('li', null, 'Add ', h('strong', null, 'Calculate Statistics'), ': Sum of the Health Samples.'),
        h('li', null, 'Add ', h('strong', null, 'Format Date'), ': Current Date, Custom format ', h('code', null, 'yyyy-MM-dd'), '.'),
        h('li', null, 'Add ', h('strong', null, 'Text'), ': ', h('code', null, 'RENSTEP [Formatted Date] [Statistics Result]'), '.'),
        h('li', null, 'Add ', h('strong', null, 'Copy to Clipboard'), '.'),
        h('li', null, 'Add it to your Home Screen. Tap it, open RenStep, tap Add steps, then Paste from Shortcut.')),
      h('div', { class: 'small muted' }, 'Allow Health access when asked. Check the first result against the Health app. If it is about double, your Watch and iPhone are both being counted: make sure Group By Day is on.')),
    h('div', { class: 'card stack' },
      h('h2', null, 'Backup'),
      h('div', { class: 'small muted' }, `Your data lives only on this phone. ${data.lastBackup ? `Last backup: ${fmtDate(data.lastBackup)}.` : 'No backup yet.'} Save a backup to Files or iCloud Drive every couple of weeks.`),
      h('button', { class: 'btn primary block', onclick: exportBackup }, 'Export backup'),
      h('label', { class: 'btn block center' }, 'Restore from backup',
        h('input', { type: 'file', accept: 'application/json,.json', class: 'visually-hidden', onchange: (ev) => importBackup(ev.target.files && ev.target.files[0]) }))),
    h('div', { class: 'card stack' },
      h('h2', null, 'Danger zone'),
      h('button', { class: 'btn danger block', onclick: () => {
        if (confirm('Erase ALL RenStep data on this phone? Export a backup first if you might want it.') && confirm('Really erase everything? This cannot be undone.')) {
          localStorage.removeItem(STORE_KEY); data = defaultState(); seedIfNeeded(); stopRest(); closeSheet(); go('today'); toast('All data erased.');
        } } }, 'Erase all data')),
    h('div', { class: 'small muted center' }, 'RenStep makes no network requests with your data.'),
  ));
}

async function exportBackup() {
  const json = JSON.stringify(data, null, 1);
  const name = `renstep-backup-${todayKey()}.json`;
  const file = new File([json], name, { type: 'application/json' });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: 'RenStep backup' });
    } else {
      const url = URL.createObjectURL(file);
      const a = h('a', { href: url, download: name });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    }
    data.lastBackup = new Date().toISOString();
    save();
    render();
    toast('Backup ready. Save it to Files or iCloud Drive.');
  } catch (e) {
    if (e && e.name === 'AbortError') return; // user closed the share sheet
    console.error(e);
    toast('Export failed. Try again.');
  }
}

async function importBackup(file) {
  if (!file) return;
  if (file.size > 20 * 1024 * 1024) { toast('That file is too big to be a RenStep backup.'); return; }
  try {
    const raw = JSON.parse(await file.text());
    if (!raw || typeof raw !== 'object' || raw.version !== 1) { toast('That is not a RenStep backup.'); return; }
    const next = normalize(raw);
    if (!confirm(`Restore this backup? It has ${next.sessions.length} workouts and ${Object.keys(next.steps).length} days of steps, and will replace what's on this phone now.`)) return;
    data = next;
    save();
    closeSheet();
    go('today');
    toast('Backup restored.');
  } catch (e) {
    console.error(e);
    toast('Could not read that file.');
  }
}

// ---------- sheet (modal) ----------
let sheetState = null;
function openSheet(title, bodyFn) {
  closeSheet();
  const root = $('#modalRoot');
  const content = h('div');
  const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'sheet-head' }, h('h2', null, title), h('button', { class: 'btn sm', onclick: closeSheet }, 'Close')),
    content);
  const backdrop = h('div', { class: 'modal-backdrop', onclick: (ev) => { if (ev.target === backdrop) closeSheet(); } }, sheet);
  const rerender = () => { const y = sheet.scrollTop; content.replaceChildren(bodyFn()); sheet.scrollTop = y; };
  rerender();
  root.replaceChildren(backdrop);
  document.body.style.overflow = 'hidden';
  sheetState = { rerender };
  return sheetState;
}
function closeSheet() {
  $('#modalRoot').replaceChildren();
  document.body.style.overflow = '';
  sheetState = null;
}

// ---------- boot ----------
function importFromHash() {
  // Optional: a Shortcut can open .../#steps=2026-11-02:8432 (works when the app runs in Safari).
  const m = location.hash.match(/^#steps=([\d-]{10}):(\d{1,6})$/);
  if (!m) return;
  history.replaceState(null, '', location.pathname + location.search);
  if (isKey(m[1]) && m[1] <= todayKey()) recordSteps(m[1], clampInt(m[2], 0, 200000, 0));
}

function boot() {
  load();
  seedIfNeeded();
  document.querySelectorAll('.tabbar button').forEach((b) => b.addEventListener('click', () => go(b.dataset.tab)));
  $('#settingsBtn').addEventListener('click', openSettings);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && sheetState) closeSheet(); });
  // Re-render when the app comes back to the foreground so "today" rolls over at midnight.
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && !sheetState) render(); });
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(console.error);
  render();
  importFromHash();
  const fresh = syncBadges();
  if (fresh.length) toast(`Badge unlocked: ${fresh.map((b) => `${b.icon} ${b.name}`).join(', ')}`, 4000);
}

boot();
