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
    settings: { goalMode: 'auto', manualGoal: 8000, restSec: 90, name: '', vibe: 'hype', daysPerWeek: 3 },
    plan: null,
    notesSeen: [],
    askedName: false,
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
      inc: clampNum(e && e.inc, 0, 50, 2.5),
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
  s.settings.name = str(st.name, 30);
  s.settings.vibe = ['hype', 'gentle', 'sassy'].includes(st.vibe) ? st.vibe : 'hype';
  s.settings.daysPerWeek = clampInt(st.daysPerWeek, 1, 7, 3);
  if (raw.plan && typeof raw.plan === 'object') {
    const pl = raw.plan;
    s.plan = {
      goal: Object.keys(GOALS).includes(pl.goal) ? pl.goal : 'consistent',
      days: clampInt(pl.days, 1, 7, 3),
      place: pl.place === 'home' ? 'home' : 'gym',
      minutes: [20, 30, 45, 60].includes(pl.minutes) ? pl.minutes : 45,
    };
  }
  if (Array.isArray(raw.notesSeen)) s.notesSeen = raw.notesSeen.filter((k) => typeof k === 'string').slice(0, 50);
  s.askedName = !!raw.askedName;
  if (raw.steps && typeof raw.steps === 'object') {
    for (const [k, v] of Object.entries(raw.steps)) if (isKey(k)) s.steps[k] = clampInt(v, 0, 200000, 0);
  }
  if (Array.isArray(raw.routines)) {
    s.routines = raw.routines.slice(0, 50).filter((r) => r && typeof r === 'object').map((r) => ({
      id: str(r.id, 64) || uid(),
      name: str(r.name, 60, 'Routine') || 'Routine',
      generated: !!r.generated || ['Upper Body', 'Lower Body', 'Home Bodyweight'].includes(r.name),
      exercises: (Array.isArray(r.exercises) ? r.exercises : []).slice(0, 30).map(normExercise).filter(Boolean),
    }));
  }
  if (Array.isArray(raw.sessions)) {
    s.sessions = raw.sessions.slice(0, 10000).filter((x) => x && typeof x === 'object' && !Number.isNaN(Date.parse(x.date))).map((x) => ({
      id: str(x.id, 64) || uid(),
      date: new Date(x.date).toISOString(),
      routineName: str(x.routineName, 60, 'Workout') || 'Workout',
      kind: x.kind === 'cardio' ? 'cardio' : 'strength',
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
  if (ACTIVITIES.includes(raw.lastActivity)) s.lastActivity = raw.lastActivity;
  if (MINUTES.includes(raw.lastMinutes)) s.lastMinutes = raw.lastMinutes;
  s.coreUpdatedAt = clampInt(raw.coreUpdatedAt, 0, 1e13, 0);
  s.deleted = Array.isArray(raw.deleted) ? raw.deleted.filter((x) => typeof x === 'string').slice(-2000) : [];
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
let lastCoreJSON = null;
function save(opts = {}) {
  try {
    const core = JSON.stringify(coreOf(data));
    if (lastCoreJSON !== null && core !== lastCoreJSON && !opts.fromSync) data.coreUpdatedAt = Date.now();
    lastCoreJSON = core;
    localStorage.setItem(STORE_KEY, JSON.stringify(data));
    if (!opts.fromSync) scheduleSync();
  } catch (e) {
    console.error(e);
    toast('Saving failed: storage may be full. Export a backup.', 5000);
  }
}

function seedIfNeeded() {
  if (data.seeded) return;
  const ex = (name, sets, repLow, repHigh, startWeight, increment) => ({ id: uid(), name, sets, repLow, repHigh, startWeight, increment });
  data.routines.push(
    { id: uid(), name: 'Upper Body', generated: true, exercises: [
      ex('Bench Press', 3, 6, 10, 40, 2.5),
      ex('Bent-over Row', 3, 8, 12, 30, 2.5),
      ex('Overhead Press', 3, 6, 10, 25, 2.5),
      ex('Lat Pulldown', 3, 8, 12, 35, 2.5),
      ex('Bicep Curl', 2, 10, 15, 10, 1),
    ] },
    { id: uid(), name: 'Lower Body', generated: true, exercises: [
      ex('Back Squat', 3, 6, 10, 50, 5),
      ex('Romanian Deadlift', 3, 8, 12, 40, 5),
      ex('Walking Lunge', 3, 8, 12, 10, 2),
      ex('Calf Raise', 3, 12, 20, 20, 5),
    ] },
    { id: uid(), name: 'Home Bodyweight', generated: true, exercises: [
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
  { id: 'cardio_10', icon: '💃', name: 'On the Move', how: '10 quick logs', test: (c) => c.cardio >= 10 },
  { id: 'level_5', icon: '⭐', name: 'Level 5', how: 'Reach level 5', test: (c) => c.level >= 5 },
  { id: 'level_10', icon: '🌟', name: 'Level 10', how: 'Reach level 10', test: (c) => c.level >= 10 },
  { id: 'level_20', icon: '👑', name: 'Level 20', how: 'Reach level 20', test: (c) => c.level >= 20 },
];

function badgeContext() {
  const t = totals();
  const stepVals = Object.values(data.steps);
  return {
    workouts: data.sessions.length,
    cardio: data.sessions.filter((s) => s.kind === 'cardio').length,
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

// Coach lines in three tones. {n} style placeholders are filled by say().
const VIBES = {
  hype: {
    trainedToday: 'Workout DONE today! Now recover like a champ: sleep and protein.',
    never: 'Day one energy! Pick a routine in Train and let\'s go.',
    longBreak: '{n} days off? Time to get back in there. Even 20 minutes counts!',
    rested: 'You\'re rested and ready. Today is a training day!',
    noSteps: 'No steps yet today. Run the RenStep Steps shortcut and tap Paste steps!',
    goalHit: 'Step goal SMASHED: {steps} steps!',
    evening: '{left} steps to go. Quick 15-minute walk and it\'s yours!',
    toGo: '{left} steps to go. You\'ve got this!',
    streak: '{n}-day streak on the line. Keep it alive today!',
    week: '{done}/{target} workouts this week.',
    weekDone: 'Weekly target hit: {done}/{target}! Anything extra is a bonus.',
    doneNormal: 'Another one in the bank! Next session\'s targets are already updated.',
    donePR: 'NEW PERSONAL BESTS! Targets for next time are updated. You\'re getting stronger!',
  },
  gentle: {
    trainedToday: 'You trained today. Be kind to yourself tonight: rest, water and a good meal.',
    never: 'Whenever you\'re ready, pick a routine in Train. We\'ll start easy.',
    longBreak: 'It\'s been {n} days, and that\'s okay. A short, easy session is a lovely way back.',
    rested: 'You\'re well rested. A workout today would feel good.',
    noSteps: 'No steps logged yet. When you have a moment, run the shortcut and paste them in.',
    goalHit: 'You reached your step goal: {steps} steps. Lovely.',
    evening: '{left} steps left. A relaxed evening walk would do it.',
    toGo: '{left} steps to go today. One step at a time.',
    streak: 'You\'re on a {n}-day streak. A little movement today keeps it going.',
    week: '{done} of {target} workouts this week.',
    weekDone: 'You\'ve done your {target} workouts this week. Rest is progress too.',
    doneNormal: 'Well done. Your next targets are updated, so you can just show up.',
    donePR: 'You set new personal bests today. Your next targets are ready.',
  },
  sassy: {
    trainedToday: 'Workout done. Now go eat something with protein in it, I\'m watching.',
    never: 'The routines aren\'t going to do themselves. Train tab. Now. 💅',
    longBreak: '{n} days?? The weights miss you. Don\'t make them beg.',
    rested: 'You\'re rested. No excuses today, babe.',
    noSteps: 'Zero steps logged. Either you\'re a statue or you forgot the shortcut.',
    goalHit: '{steps} steps. Main character behaviour.',
    evening: '{left} steps short. Put your shoes on, it\'s one walk.',
    toGo: '{left} steps to go. The couch can wait.',
    streak: '{n}-day streak. Break it and I\'ll be very dramatic about it.',
    week: '{done}/{target} workouts this week. Do the maths.',
    weekDone: '{done}/{target} this week. Okay, showing off now.',
    doneNormal: 'Done and dusted. Next targets updated, try to keep up 😌',
    donePR: 'New PRs?? Who said you could be this strong. Targets updated.',
  },
};
function say(key, vars = {}) {
  const t = (VIBES[data.settings.vibe] || VIBES.hype)[key] || VIBES.hype[key] || '';
  return t.replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : ''));
}

function startOfWeekKey() {
  const d = new Date();
  const dow = (d.getDay() + 6) % 7; // Monday = 0
  d.setDate(d.getDate() - dow);
  return keyOf(d);
}
function workoutsThisWeek() {
  const from = startOfWeekKey();
  return data.sessions.filter((s) => s.kind !== 'cardio' && keyOf(new Date(s.date)) >= from).length;
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
  if (daysSince === 0) tips.push(say('trainedToday'));
  else if (daysSince === null) tips.push(say('never'));
  else if (daysSince >= 4) tips.push(say('longBreak', { n: daysSince }));
  else if (daysSince >= 2) tips.push(say('rested'));
  if (steps == null) tips.push(say('noSteps'));
  else if (steps >= goal) tips.push(say('goalHit', { steps: fmtInt(steps) }));
  else if (now.getHours() >= 17) tips.push(say('evening', { left: fmtInt(goal - steps) }));
  else tips.push(say('toGo', { left: fmtInt(goal - steps) }));
  if (streak >= 3 && !isActiveDay(today, workoutDayKeys())) tips.push(say('streak', { n: streak }));
  return tips.slice(0, 2).join(' ');
}

function nextRoutine() {
  if (!data.routines.length) return null;
  const last = [...data.sessions].reverse().find((s) => s.kind !== 'cardio');
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
  let title = ui.tab === 'today' && data.settings.name ? `Hi ${data.settings.name}` : TITLES[ui.tab];
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
  const needsBackup = !cloud.auth && (data.sessions.length > 0 || Object.keys(data.steps).length > 3) && (backupDays === null || backupDays >= 7);

  return h('div', null,
    h('div', { class: 'card' },
      h('div', { class: 'ring-wrap' },
        stepRing(steps, goal),
        h('div', { class: 'grow' },
          h('div', { class: 'big-num' }, fmtInt(steps)),
          h('div', { class: 'muted small' }, `steps of ${fmtInt(goal)} goal`, data.settings.goalMode === 'auto' ? ' (auto)' : ''),
          h('div', { class: 'paste-cta' },
            h('button', { class: 'btn primary sm', onclick: pasteSteps }, '📋 Paste steps'),
            h('button', { class: 'btn sm', onclick: () => openStepsSheet() }, 'Type'))))),
    !data.plan ? h('div', { class: 'card' },
      h('div', { class: 'row between' },
        h('div', null, h('strong', null, 'Get your own plan'), h('div', { class: 'small muted' }, '5 quick taps, no typing')),
        h('button', { class: 'btn primary sm', onclick: openPlanQuiz }, 'Start'))) : null,
    h('div', { class: 'card coach' },
      h('div', { class: 'who' }, 'Coach'),
      h('div', null, dailyTip())),
    levelCard(t, streak),
    nr && !data.activeWorkout ? h('div', { class: 'card' },
      h('div', { class: 'row between' },
        h('div', null, h('div', { class: 'small muted' }, 'Up next'), h('strong', null, nr.name),
          h('div', { class: 'small muted' }, workoutsThisWeek() >= data.settings.daysPerWeek
            ? say('weekDone', { done: workoutsThisWeek(), target: data.settings.daysPerWeek })
            : say('week', { done: workoutsThisWeek(), target: data.settings.daysPerWeek }))),
        h('div', { class: 'row' },
          h('button', { class: 'btn sm', onclick: openQuickLog }, '⚡ Quick log'),
          h('button', { class: 'btn primary sm', onclick: () => startWorkout(nr.id) }, 'Start')))) : null,
    data.activeWorkout ? h('div', { class: 'card' },
      h('div', { class: 'row between' },
        h('div', null, h('div', { class: 'small muted' }, 'In progress'), h('strong', null, data.activeWorkout.routineName)),
        h('button', { class: 'btn warm sm', onclick: () => go('train') }, 'Resume'))) : null,
    h('div', { class: 'card' },
      h('h2', null, 'Last 7 days'),
      weekChart(),
      h('div', { class: 'small muted' }, 'Pink bars hit the goal. The dashed line is today\'s goal.')),
    cloudReady() && !cloud.auth ? h('div', { class: 'card note' },
      h('div', { class: 'who' }, '☁️ Cloud backup'),
      h('div', null, 'Sign in once and your progress saves itself, even if you change phones.'),
      h('div', { class: 'paste-cta' }, h('button', { class: 'btn primary sm', onclick: openSettings }, 'Turn it on'))) : null,
    needsBackup && !cloudReady() ? h('div', { class: 'card note' },
      h('div', { class: 'who' }, '🛟 Weekly backup'),
      h('div', null, backupDays === null ? 'Keep your progress safe: save a backup to iCloud Drive.' : `Last backup was ${backupDays} days ago. Save a fresh one so nothing gets lost.`),
      h('div', { class: 'paste-cta' },
        h('button', { class: 'btn primary sm', onclick: exportBackup }, 'Save backup'),
        h('div', { class: 'small muted' }, 'In the share sheet, tap Save to Files, then iCloud Drive.'))) : null,
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
    h('div', { class: 'stack' },
      h('button', { class: 'btn primary block', onclick: openPlanQuiz }, data.plan ? '✨ Redo my plan' : '✨ Build my plan (1 min)'),
      h('button', { class: 'btn block', onclick: () => openRoutineEditor(null) }, '+ New routine'),
      h('button', { class: 'btn block', onclick: openQuickLog }, '⚡ Quick log a walk, run or class')),
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
      return { name: ex.name, order: i, inc: ex.increment, target: t,
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
      h('div', { class: 'set-row set-head' }, h('span', { class: 'center' }, '#'), h('span', { class: 'center' }, 'kg'), h('span', { class: 'center' }, 'Reps'), h('span')),
      e.sets.map((s, si) => setRow(ei, si, s)),
      h('div', { class: 'row' },
        h('button', { class: 'btn sm', onclick: () => {
          const prev = e.sets[e.sets.length - 1] || { weight: e.target.weight, reps: e.target.reps };
          e.sets.push({ weight: prev.weight, reps: prev.reps, done: false }); save(); render();
        } }, '+ Set'),
        e.sets.length > 1 ? h('button', { class: 'btn sm', onclick: () => { e.sets.pop(); save(); render(); } }, '− Set') : null,
        e.sets.some((s) => !s.done) ? h('button', { class: 'btn primary sm', onclick: () => {
          e.sets.forEach((s) => { s.done = true; }); save(); startRest(data.settings.restSec); render();
        } }, '✓ All done') : null),
    )),
    h('div', { class: 'stack' },
      h('button', { class: 'btn primary block', onclick: finishWorkout }, 'Finish workout'),
      h('button', { class: 'btn danger block', onclick: () => {
        if (confirm('Discard this workout? Nothing will be saved.')) { data.activeWorkout = null; stopRest(); save(); go('train'); }
      } }, 'Discard workout')),
  );
}

function stepper(value, label, mode, step, min, max, onChange) {
  const input = h('input', { type: 'text', inputmode: mode, value: trimNum(value), 'aria-label': label,
    onfocus: (ev) => ev.target.select(),
    oninput: (ev) => onChange(clampNum(String(ev.target.value).replace(',', '.'), min, max, min)) });
  const bump = (dir) => () => {
    const cur = clampNum(String(input.value).replace(',', '.'), min, max, min);
    const next = Math.min(max, Math.max(min, Math.round((cur + dir * step) * 100) / 100));
    input.value = trimNum(next);
    onChange(next);
  };
  return h('div', { class: 'stepper' },
    h('button', { 'aria-label': `Less ${label}`, onclick: bump(-1) }, '−'), input,
    h('button', { 'aria-label': `More ${label}`, onclick: bump(1) }, '+'));
}

function setRow(ei, si, s) {
  const w = data.activeWorkout;
  const ex = w.exercises[ei];
  const set = ex.sets[si];
  const wStep = ex.inc > 0 ? ex.inc : 2.5;
  return h('div', { class: s.done ? 'set-row done' : 'set-row' },
    h('span', { class: 'idx' }, String(si + 1)),
    stepper(s.weight, `set ${si + 1} kg`, 'decimal', wStep, 0, 2000, (v) => { set.weight = v; save(); }),
    stepper(s.reps, `set ${si + 1} reps`, 'numeric', 1, 0, 1000, (v) => { set.reps = Math.round(v); save(); }),
    h('button', { class: s.done ? 'check done' : 'check', 'aria-label': s.done ? 'Mark set not done' : 'Mark set done', 'aria-pressed': s.done ? 'true' : 'false',
      onclick: () => {
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
  const notes = takeNotes(newBadges.map((b) => b.id));
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
      prs.length ? say('donePR') : say('doneNormal'))),
    notes.map(noteCard),
  ));
}

// ---------- quick cardio log ----------
const ACTIVITIES = ['🚶 Walk', '🏃 Run', '🚴 Cycle', '🧘 Yoga', '🏊 Swim', '💃 Dance', '🥊 Class', '🧗 Hike', '⛹️ Sport'];
const MINUTES = [10, 15, 20, 30, 45, 60, 90];
const cardioXP = (min) => 20 + Math.min(60, Math.round(min / 2));

function openQuickLog() {
  const st = { activity: data.lastActivity || ACTIVITIES[0], min: data.lastMinutes || 30 };
  const body = () => h('div', { class: 'stack' },
    h('div', { class: 'small muted' }, 'What did you do?'),
    h('div', { class: 'chips' }, ACTIVITIES.map((a) => h('button', { class: a === st.activity ? 'chip on' : 'chip', onclick: () => { st.activity = a; rerender(); } }, a))),
    h('div', { class: 'small muted' }, 'For how long?'),
    h('div', { class: 'chips' }, MINUTES.map((m) => h('button', { class: m === st.min ? 'chip on' : 'chip', onclick: () => { st.min = m; rerender(); } }, `${m} min`))),
    h('button', { class: 'btn primary block', onclick: () => {
      const before = totals();
      const xp = cardioXP(st.min);
      data.sessions.push({ id: uid(), date: new Date(Date.now() - st.min * 60000).toISOString(), routineName: st.activity, kind: 'cardio', durationMin: st.min, xp, sets: [] });
      data.sessions.sort((a, b) => a.date.localeCompare(b.date));
      data.lastActivity = st.activity; data.lastMinutes = st.min;
      save();
      const fresh = syncBadges();
      closeSheet(); render();
      const lvl = totals().level;
      toast(`${st.activity} logged: +${xp} XP${lvl > before.level ? ` · Level ${lvl}! 🎉` : ''}`, 3500);
      if (fresh.length) setTimeout(() => toast(`Badge unlocked: ${fresh.map((b) => `${b.icon} ${b.name}`).join(', ')}`, 4000), 3600);
      showNotes(takeNotes(fresh.map((b) => b.id)));
    } }, `Log it (+${cardioXP(st.min)} XP)`),
  );
  const { rerender } = openSheet('Quick log', body);
}

// ---------- exercise library ----------
// name, sets, min reps, max reps, start kg, kg step
const LIBRARY = {
  'Glutes & legs': [['Hip Thrust', 3, 8, 12, 40, 5], ['Back Squat', 3, 6, 10, 40, 5], ['Goblet Squat', 3, 8, 12, 12, 2], ['Romanian Deadlift', 3, 8, 12, 30, 5], ['Leg Press', 3, 10, 15, 60, 10], ['Walking Lunge', 3, 8, 12, 8, 2], ['Bulgarian Split Squat', 3, 8, 12, 6, 2], ['Cable Kickback', 3, 12, 15, 5, 2.5], ['Hip Abduction', 3, 12, 20, 30, 5], ['Leg Curl', 3, 10, 15, 20, 5], ['Leg Extension', 3, 10, 15, 20, 5], ['Calf Raise', 3, 12, 20, 20, 5]],
  'Back & arms': [['Lat Pulldown', 3, 8, 12, 30, 2.5], ['Seated Cable Row', 3, 8, 12, 30, 2.5], ['Dumbbell Row', 3, 8, 12, 10, 2], ['Assisted Pull-up', 3, 6, 10, 0, 0], ['Bicep Curl', 3, 10, 15, 6, 1], ['Hammer Curl', 3, 10, 15, 6, 1], ['Tricep Pushdown', 3, 10, 15, 15, 2.5]],
  'Chest & shoulders': [['Bench Press', 3, 6, 10, 30, 2.5], ['Dumbbell Bench Press', 3, 8, 12, 10, 2], ['Incline Dumbbell Press', 3, 8, 12, 8, 2], ['Overhead Press', 3, 6, 10, 20, 2.5], ['Dumbbell Shoulder Press', 3, 8, 12, 6, 2], ['Lateral Raise', 3, 12, 15, 4, 1], ['Push-up', 3, 8, 15, 0, 0]],
  'Core & bodyweight': [['Glute Bridge', 3, 10, 20, 0, 0], ['Crunch', 3, 12, 25, 0, 0], ['Hanging Knee Raise', 3, 8, 15, 0, 0], ['Russian Twist', 3, 16, 30, 0, 0], ['Bodyweight Squat', 3, 12, 25, 0, 0], ['Mountain Climber', 3, 20, 40, 0, 0], ['Burpee', 3, 8, 15, 0, 0]],
};
const libEx = ([name, sets, repLow, repHigh, startWeight, increment]) => ({ id: uid(), name, sets, repLow, repHigh, startWeight, increment });

// ---------- routine editor ----------
function openRoutineEditor(routine) {
  const draft = {
    name: routine ? routine.name : '',
    exercises: routine ? routine.exercises.map((e) => ({ ...e })) : [],
    group: Object.keys(LIBRARY)[0],
    custom: '',
  };
  const body = () => {
    const names = new Set(draft.exercises.map((e) => e.name));
    return h('div', { class: 'stack' },
      h('label', { class: 'field' }, 'Routine name',
        h('input', { type: 'text', value: draft.name, maxlength: 60, placeholder: 'e.g. Glute Day', oninput: (ev) => { draft.name = ev.target.value; } })),
      h('div', { class: 'small muted' }, 'Tap exercises to add them. Starting weights are guesses; change them on your first workout and the coach takes over.'),
      h('div', { class: 'chips' }, Object.keys(LIBRARY).map((g) => h('button', { class: g === draft.group ? 'chip on' : 'chip', onclick: () => { draft.group = g; rerender(); } }, g))),
      h('div', { class: 'chips' }, LIBRARY[draft.group].map((row) => h('button', {
        class: names.has(row[0]) ? 'chip added' : 'chip',
        onclick: () => { if (!names.has(row[0])) { draft.exercises.push(libEx(row)); rerender(); } },
      }, names.has(row[0]) ? `✓ ${row[0]}` : `+ ${row[0]}`))),
      h('div', { class: 'row' },
        h('input', { type: 'text', class: 'grow', placeholder: 'Something else? Type it', value: draft.custom, maxlength: 60, oninput: (ev) => { draft.custom = ev.target.value; } }),
        h('button', { class: 'btn sm', onclick: () => {
          const n = str(draft.custom, 60);
          if (!n) return;
          draft.exercises.push({ id: uid(), name: n, sets: 3, repLow: 8, repHigh: 12, startWeight: 0, increment: 2.5 });
          draft.custom = ''; rerender();
        } }, 'Add')),
      draft.exercises.length ? h('div', { class: 'section-label' }, `In this routine (${draft.exercises.length})`) : null,
      draft.exercises.map((ex, i) => h('div', { class: 'card stack' },
        h('div', { class: 'row between' }, h('strong', null, ex.name),
          h('div', { class: 'row' },
            i > 0 ? h('button', { class: 'btn sm', 'aria-label': 'Move up', onclick: () => { draft.exercises.splice(i - 1, 0, draft.exercises.splice(i, 1)[0]); rerender(); } }, '↑') : null,
            h('button', { class: 'btn danger sm', onclick: () => { draft.exercises.splice(i, 1); rerender(); } }, 'Remove'))),
        h('div', { class: 'grid3' },
          h('label', { class: 'field' }, 'Sets', stepper(ex.sets, 'sets', 'numeric', 1, 1, 12, (v) => { ex.sets = v; })),
          h('label', { class: 'field' }, 'Min reps', stepper(ex.repLow, 'min reps', 'numeric', 1, 1, 100, (v) => { ex.repLow = v; })),
          h('label', { class: 'field' }, 'Max reps', stepper(ex.repHigh, 'max reps', 'numeric', 1, 1, 200, (v) => { ex.repHigh = v; }))),
        h('div', { class: 'grid2' },
          h('label', { class: 'field' }, 'Start kg (0 = bodyweight)', stepper(ex.startWeight, 'start kg', 'decimal', ex.increment || 2.5, 0, 1000, (v) => { ex.startWeight = v; })),
          h('label', { class: 'field' }, 'Add per step (kg)', stepper(ex.increment, 'kg step', 'decimal', 0.5, 0, 50, (v) => { ex.increment = v; }))),
      )),
      h('button', { class: 'btn primary block', onclick: saveRoutine }, 'Save routine'),
    );
  };
  const saveRoutine = () => {
    const name = str(draft.name, 60) || (draft.exercises[0] ? `${draft.exercises[0].name} day` : '');
    if (!name) { toast('Add at least one exercise.'); return; }
    const exercises = draft.exercises.map(normExercise).filter(Boolean);
    if (!exercises.length) { toast('Add at least one exercise.'); return; }
    if (routine) { routine.name = name; routine.exercises = exercises; }
    else data.routines.push({ id: uid(), name, exercises });
    save();
    closeSheet();
    go('train', { routineId: routine ? routine.id : data.routines[data.routines.length - 1].id });
  };
  const { rerender } = openSheet(routine ? 'Edit routine' : 'New routine', body);
}

// ---------- plan quiz ----------
const GOALS = {
  tone: { label: '✨ Tone up', reps: [10, 15], rest: 75, steps: 8000 },
  strong: { label: '💪 Get stronger', reps: [5, 8], rest: 120, steps: 7500 },
  lean: { label: '🔥 Lose fat', reps: [12, 15], rest: 60, steps: 10000 },
  consistent: { label: '📅 Just be consistent', reps: [8, 12], rest: 90, steps: 7000 },
};
const PLAN_TEMPLATES = {
  gym: [
    ['Glutes & Legs', ['Hip Thrust', 'Goblet Squat', 'Romanian Deadlift', 'Hip Abduction', 'Walking Lunge', 'Calf Raise']],
    ['Upper Body', ['Lat Pulldown', 'Dumbbell Shoulder Press', 'Seated Cable Row', 'Lateral Raise', 'Bicep Curl', 'Tricep Pushdown']],
    ['Booty & Core', ['Bulgarian Split Squat', 'Hip Thrust', 'Cable Kickback', 'Leg Curl', 'Hanging Knee Raise', 'Russian Twist']],
    ['Full Body', ['Leg Press', 'Dumbbell Row', 'Incline Dumbbell Press', 'Romanian Deadlift', 'Lateral Raise', 'Crunch']],
  ],
  home: [
    ['Home Glutes & Legs', ['Glute Bridge', 'Bodyweight Squat', 'Walking Lunge', 'Bulgarian Split Squat', 'Calf Raise', 'Russian Twist']],
    ['Home Upper & Core', ['Push-up', 'Pike Push-up', 'Crunch', 'Mountain Climber', 'Russian Twist', 'Hanging Knee Raise']],
    ['Home Sweat', ['Burpee', 'Bodyweight Squat', 'Mountain Climber', 'Glute Bridge', 'Push-up', 'Crunch']],
    ['Home Full Body', ['Bodyweight Squat', 'Push-up', 'Glute Bridge', 'Walking Lunge', 'Pike Push-up', 'Crunch']],
  ],
};
const ALL_LIB = Object.values(LIBRARY).flat();

function buildPlan(plan) {
  const g = GOALS[plan.goal];
  const count = plan.days <= 2 ? 2 : Math.min(plan.days, 4);
  const perRoutine = { 20: 3, 30: 4, 45: 5, 60: 6 }[plan.minutes] || 5;
  let templates = PLAN_TEMPLATES[plan.place];
  if (count === 2) templates = [templates[3], templates[0]].map((t, i) => [i ? t[0] : t[0], t[1]]);
  return templates.slice(0, count).map(([name, list]) => ({
    id: uid(), name, generated: true,
    exercises: list.slice(0, perRoutine).map((exName) => {
      const row = ALL_LIB.find((r) => r[0] === exName) || [exName, 3, 8, 12, 0, 0];
      const ex = libEx(row);
      if (plan.place === 'home') { ex.startWeight = 0; ex.increment = 0; }
      if (ex.increment > 0) { ex.repLow = g.reps[0]; ex.repHigh = g.reps[1]; }
      if (plan.goal === 'strong' && plan.minutes >= 45 && ex.increment > 0) ex.sets = 4;
      return ex;
    }),
  }));
}

function openPlanQuiz() {
  const st = { i: 0, goal: data.plan ? data.plan.goal : null, days: data.plan ? data.plan.days : null, place: data.plan ? data.plan.place : null, minutes: data.plan ? data.plan.minutes : null, vibe: data.settings.vibe };
  const Q = [
    ['What\'s the main goal?', 'goal', Object.entries(GOALS).map(([k, v]) => [k, v.label])],
    ['How many days a week can you train?', 'days', [[2, '2 days'], [3, '3 days'], [4, '4 days'], [5, '5+ days']]],
    ['Where do you work out?', 'place', [['gym', '🏋️ Gym'], ['home', '🏠 Home, no equipment']]],
    ['How long per session?', 'minutes', [[20, '20 min'], [30, '30 min'], [45, '45 min'], [60, '1 hour']]],
    ['Pick your coach vibe', 'vibe', [['hype', '📣 Hype me up'], ['gentle', '🌸 Keep it gentle'], ['sassy', '💅 Sassy']]],
  ];
  const finish = () => {
    const plan = { goal: st.goal, days: st.days, place: st.place, minutes: st.minutes };
    const g = GOALS[plan.goal];
    const custom = data.routines.filter((r) => !r.generated);
    data.routines = [...buildPlan(plan), ...custom];
    data.plan = plan;
    data.settings.vibe = st.vibe;
    data.settings.daysPerWeek = plan.days;
    data.settings.restSec = g.rest;
    data.settings.manualGoal = g.steps;
    data.seeded = true;
    save();
    closeSheet();
    go('train');
    toast(`Your plan is ready: ${data.routines.filter((r) => r.generated).length} routines 💗`, 3500);
    const welcome = () => showNotes(takeNotes(['welcome']));
    if (cloudReady() && !cloud.auth) {
      cloudCard.onDone = () => { closeSheet(); welcome(); };
      setTimeout(() => openSheet('Last step: save your progress ☁️', () => h('div', { class: 'stack' },
        h('div', null, 'Make an account so your workouts and steps are never lost, even if you change phones. You only do this once and stay signed in.'),
        cloudCard(),
        h('button', { class: 'btn sm', onclick: () => { cloudCard.onDone = null; closeSheet(); welcome(); } }, 'Skip for now'))), 300);
    } else welcome();
  };
  const body = () => {
    const [q, key, opts] = Q[st.i];
    return h('div', { class: 'stack' },
      h('div', { class: 'small muted' }, `Question ${st.i + 1} of ${Q.length}`),
      h('h2', null, q),
      h('div', { class: 'stack' }, opts.map(([v, label]) => h('button', {
        class: st[key] === v ? 'btn primary block' : 'btn block',
        onclick: () => { st[key] = v; if (st.i < Q.length - 1) { st.i++; rerender(); } else finish(); },
      }, label))),
      st.i > 0 ? h('button', { class: 'btn sm', onclick: () => { st.i--; rerender(); } }, '‹ Back') : null,
      st.i === 0 ? h('div', { class: 'small muted' }, 'This builds your routines, step goal and rest timer. Your own routines are kept. You can redo it any time in Settings.') : null,
    );
  };
  const { rerender } = openSheet('Build my plan', body);
}

// ---------- secret notes ----------
function notesConfig() {
  const cfg = window.RENSTEP_NOTES;
  const out = { from: 'A friend', notes: {} };
  if (!cfg || typeof cfg !== 'object') return out;
  out.from = str(cfg.from, 40, out.from) || out.from;
  if (cfg.notes && typeof cfg.notes === 'object') {
    for (const [k, v] of Object.entries(cfg.notes)) if (typeof v === 'string' && v.trim()) out.notes[k] = v.trim().slice(0, 500);
  }
  return out;
}
const NOTE_LABELS = { welcome: 'Your first plan' };
function noteLabel(id) { const b = BADGES.find((x) => x.id === id); return NOTE_LABELS[id] || (b ? `${b.icon} ${b.name}` : id); }
// Returns notes for these milestone ids that haven't been shown yet, and marks them shown.
function takeNotes(ids) {
  const { notes } = notesConfig();
  const fresh = ids.filter((id) => notes[id] && !data.notesSeen.includes(id));
  if (!fresh.length) return [];
  data.notesSeen.push(...fresh);
  save();
  return fresh.map((id) => ({ id, text: notes[id] }));
}
function noteCard(n) {
  return h('div', { class: 'card note' },
    h('div', { class: 'who' }, `💌 ${noteLabel(n.id)}`),
    h('div', { class: 'note-text' }, n.text),
    h('div', { class: 'small muted' }, `— ${notesConfig().from}`));
}
function showNotes(list) {
  if (!list.length) return;
  setTimeout(() => openSheet(`A note from ${notesConfig().from} 💌`, () => h('div', { class: 'stack' }, list.map(noteCard))), 400);
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
  showNotes(takeNotes(fresh.map((b) => b.id)));
}

async function pasteSteps() {
  try {
    const parsed = parseStepsText(await navigator.clipboard.readText());
    if (!parsed) { toast('No steps on the clipboard. Run the RenStep Steps shortcut first.', 3500); return; }
    if (parsed.date && parsed.date > todayKey()) { toast('That step count is dated in the future.'); return; }
    closeSheet();
    recordSteps(parsed.date || todayKey(), parsed.steps);
  } catch (e) {
    openStepsSheet();
    toast('Paste was blocked. Long-press the Steps box and choose Paste.', 4000);
  }
}

function openStepsSheet() {
  const state = { date: todayKey(), value: data.steps[todayKey()] != null ? String(data.steps[todayKey()]) : '' };
  const body = () => h('div', { class: 'stack' },
    h('button', { class: 'btn primary block', onclick: pasteSteps }, '📋 Paste from Shortcut'),
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
        h('div', { class: 'small muted' }, s.kind === 'cardio' ? `${fmtDate(s.date)} · ${s.durationMin} min · +${s.xp} XP` : `${fmtDate(s.date)} · ${s.sets.length} sets${vol > 0 ? ` · ${fmtInt(vol)} kg` : ''} · +${s.xp} XP`)),
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
        data.sessions = data.sessions.filter((x) => x.id !== id); data.deleted.push(id); save(); closeSheet(); render();
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
    (() => {
      const { notes, from } = notesConfig();
      const ids = Object.keys(notes);
      if (!ids.length) return null;
      const seen = ids.filter((id) => data.notesSeen.includes(id));
      return h('div', null,
        h('div', { class: 'section-label' }, `Notes from ${from} · ${seen.length}/${ids.length}`),
        seen.map((id) => noteCard({ id, text: notes[id] })),
        seen.length < ids.length ? h('div', { class: 'card small muted center' }, `🔒 ${ids.length - seen.length} more hidden. Keep going to unlock them.`) : null);
    })(),
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
      h('h2', null, 'You'),
      h('label', { class: 'field' }, 'Your name',
        h('input', { type: 'text', value: data.settings.name, maxlength: 30, autocomplete: 'given-name',
          onchange: (ev) => { data.settings.name = str(ev.target.value, 30); save(); render(); } })),
      h('label', { class: 'field' }, 'Coach vibe',
        h('select', { onchange: (ev) => { data.settings.vibe = ev.target.value; save(); render(); } },
          [['hype', '📣 Hype me up'], ['gentle', '🌸 Gentle'], ['sassy', '💅 Sassy']].map(([v, l]) => h('option', { value: v, selected: data.settings.vibe === v }, l)))),
      h('label', { class: 'field' }, 'Workouts per week target',
        stepper(data.settings.daysPerWeek, 'workouts per week', 'numeric', 1, 1, 7, (v) => { data.settings.daysPerWeek = v; save(); })),
      h('button', { class: 'btn block', onclick: () => { closeSheet(); openPlanQuiz(); } }, data.plan ? '✨ Redo my plan quiz' : '✨ Build my plan')),
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
        h('li', null, 'Add it to your Home Screen. Tap it, open RenStep, tap Paste steps.')),
      h('div', { class: 'small' }, h('strong', null, 'Make it automatic: '), 'Shortcuts → Automation → New → Time of Day (e.g. 20:00, daily) → Run Immediately → RenStep Steps. Your steps are then waiting on the clipboard; open RenStep and tap Paste steps.'),
      h('div', { class: 'small muted' }, 'Allow Health access when asked. Check the first result against the Health app. If it is about double, your Watch and iPhone are both being counted: make sure Group By Day is on.')),
    cloudCard(),
    h('div', { class: 'card stack' },
      h('h2', null, 'Backup file'),
      h('div', { class: 'small muted' }, `Your data lives only on this phone. ${data.lastBackup ? `Last backup: ${fmtDate(data.lastBackup)}.` : 'No backup yet.'} Save a backup to Files or iCloud Drive every couple of weeks.`),
      h('button', { class: 'btn primary block', onclick: exportBackup }, 'Export backup'),
      h('label', { class: 'btn block center' }, 'Restore from backup',
        h('input', { type: 'file', accept: 'application/json,.json', class: 'visually-hidden', onchange: (ev) => importBackup(ev.target.files && ev.target.files[0]) }))),
    h('div', { class: 'card stack' },
      h('h2', null, 'Danger zone'),
      h('button', { class: 'btn danger block', onclick: () => {
        if (confirm(`Erase ALL RenStep data on this phone?${cloud.auth ? ' You will be signed out; your cloud copy is kept and comes back when you sign in again.' : ' Export a backup first if you might want it.'}`) && confirm('Really erase everything on this phone?')) {
          signOut(true); localStorage.removeItem(STORE_KEY); data = defaultState(); lastCoreJSON = null; seedIfNeeded(); stopRest(); closeSheet(); go('today'); toast('All data erased.');
        } } }, 'Erase all data')),
    h('div', { class: 'small muted center' }, cloud.auth ? 'Your data syncs only to your own private cloud folder.' : 'RenStep makes no network requests with your data.'),
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

// ---------- cloud sync (Firebase Auth + Firestore REST, no SDK) ----------
// The phone stays the source of truth and works offline. When signed in, changes are pushed
// a few seconds after each save, and the cloud copy is pulled and merged when the app opens.
const AUTH_KEY = 'renstep.auth';
const SYNC_KEY = 'renstep.sync';
const CORE_KEYS = ['createdAt', 'settings', 'routines', 'badges', 'notesSeen', 'plan', 'askedName', 'seeded', 'lastBackup', 'lastActivity', 'lastMinutes', 'deleted'];
const cloud = { auth: null, status: '', busy: false, timer: null, again: false };

function cloudReady() {
  const c = window.RENSTEP_FIREBASE;
  return !!(c && typeof c.apiKey === 'string' && c.apiKey && typeof c.projectId === 'string' && /^[a-z0-9-]{4,40}$/.test(c.projectId));
}
function coreOf(d) { const o = {}; for (const k of CORE_KEYS) o[k] = d[k]; return o; }
function readJSON(key) { try { return JSON.parse(localStorage.getItem(key)) || null; } catch (e) { return null; } }
function syncState() { return readJSON(SYNC_KEY) || { hashes: {}, lastSync: null }; }
function writeSyncState(st) { try { localStorage.setItem(SYNC_KEY, JSON.stringify(st)); } catch (e) { /* ignore */ } }
cloud.auth = (() => { const a = readJSON(AUTH_KEY); return a && typeof a.uid === 'string' && typeof a.refreshToken === 'string' ? a : null; })();
function saveAuth() { try { cloud.auth ? localStorage.setItem(AUTH_KEY, JSON.stringify(cloud.auth)) : localStorage.removeItem(AUTH_KEY); } catch (e) { /* ignore */ } }

const AUTH_ERRORS = {
  EMAIL_EXISTS: 'That email already has an account. Use Sign in instead.',
  EMAIL_NOT_FOUND: 'Wrong email or password.',
  INVALID_PASSWORD: 'Wrong email or password.',
  INVALID_LOGIN_CREDENTIALS: 'Wrong email or password.',
  INVALID_EMAIL: 'That email address doesn\'t look right.',
  MISSING_PASSWORD: 'Enter a password.',
  TOO_MANY_ATTEMPTS_TRY_LATER: 'Too many tries. Wait a few minutes and try again.',
  OPERATION_NOT_ALLOWED: 'New accounts are switched off for this app.',
  ADMIN_ONLY_OPERATION: 'New accounts are switched off for this app.',
  USER_DISABLED: 'This account has been disabled.',
};
async function authPost(url, body, form) {
  const res = await fetch(url, form
    ? { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body }
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = String((j.error && j.error.message) || res.status).split(' ')[0].split(':')[0];
    const err = new Error(AUTH_ERRORS[code] || (code.startsWith('WEAK_PASSWORD') ? 'Use at least 6 characters for the password.' : `Sign-in failed (${code}).`));
    err.code = code;
    throw err;
  }
  return j;
}
const keyParam = () => `key=${encodeURIComponent(window.RENSTEP_FIREBASE.apiKey)}`;

async function signIn(email, password, create) {
  const j = await authPost(`https://identitytoolkit.googleapis.com/v1/accounts:${create ? 'signUp' : 'signInWithPassword'}?${keyParam()}`,
    { email, password, returnSecureToken: true });
  cloud.auth = { uid: j.localId, email: j.email, idToken: j.idToken, refreshToken: j.refreshToken, expiresAt: Date.now() + Number(j.expiresIn || 3600) * 1000 };
  saveAuth();
  writeSyncState({ hashes: {}, lastSync: null }); // first sync on this phone: cloud settings win
  await syncNow();
}
async function resetPassword(email) {
  await authPost(`https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?${keyParam()}`, { requestType: 'PASSWORD_RESET', email });
}
function signOut(quiet) {
  cloud.auth = null; saveAuth();
  writeSyncState({ hashes: {}, lastSync: null });
  cloud.status = '';
  if (!quiet) { toast('Signed out. Your data stays on this phone.'); }
}
async function idToken() {
  const a = cloud.auth;
  if (!a) throw new Error('Not signed in');
  if (a.idToken && Date.now() < a.expiresAt - 60000) return a.idToken;
  try {
    const j = await authPost(`https://securetoken.googleapis.com/v1/token?${keyParam()}`,
      `grant_type=refresh_token&refresh_token=${encodeURIComponent(a.refreshToken)}`, true);
    Object.assign(a, { idToken: j.id_token, refreshToken: j.refresh_token, expiresAt: Date.now() + Number(j.expires_in || 3600) * 1000 });
    saveAuth();
    return a.idToken;
  } catch (e) {
    if (['TOKEN_EXPIRED', 'USER_DISABLED', 'USER_NOT_FOUND', 'INVALID_REFRESH_TOKEN'].includes(e.code)) {
      signOut(true); render();
      throw new Error('Please sign in again.');
    }
    throw e;
  }
}
function chunksUrl() {
  const c = window.RENSTEP_FIREBASE;
  return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(c.projectId)}/databases/(default)/documents/users/${encodeURIComponent(cloud.auth.uid)}/chunks`;
}
async function fsFetch(url, init = {}) {
  const t = await idToken();
  const res = await fetch(url, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' } });
  if (!res.ok && res.status !== 404) throw new Error(`Cloud error ${res.status}`);
  return res;
}
async function pullChunks() {
  const out = {};
  let page = '';
  do {
    const res = await fsFetch(`${chunksUrl()}?pageSize=300${page ? `&pageToken=${encodeURIComponent(page)}` : ''}`);
    if (res.status === 404) break;
    const j = await res.json();
    for (const d of j.documents || []) {
      const id = String(d.name || '').split('/').pop();
      try { out[id] = JSON.parse(d.fields.json.stringValue); } catch (e) { /* skip bad chunk */ }
    }
    page = j.nextPageToken || '';
  } while (page);
  return out;
}
async function putChunk(id, obj) {
  await fsFetch(`${chunksUrl()}/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ fields: { json: { stringValue: JSON.stringify(obj) }, updatedAt: { integerValue: String(Date.now()) } } }),
  });
}
// Split the data into small documents so no single one grows past Firestore's 1 MB limit.
function toChunks(d) {
  const out = { core: { ...coreOf(d), coreUpdatedAt: d.coreUpdatedAt } };
  for (const [k, v] of Object.entries(d.steps)) (out[`steps-${k.slice(0, 4)}`] = out[`steps-${k.slice(0, 4)}`] || {})[k] = v;
  for (const sess of d.sessions) (out[`sessions-${sess.date.slice(0, 7)}`] = out[`sessions-${sess.date.slice(0, 7)}`] || []).push(sess);
  return out;
}
function mergeCloud(local, remote, cloudWinsCore) {
  const out = JSON.parse(JSON.stringify(local));
  const rc = remote.core && typeof remote.core === 'object' ? remote.core : null;
  // Steps: this phone's numbers win; days only in the cloud are filled in.
  for (const [id, obj] of Object.entries(remote)) {
    if (!id.startsWith('steps-') || !obj || typeof obj !== 'object') continue;
    for (const [k, v] of Object.entries(obj)) if (!(k in out.steps)) out.steps[k] = v;
  }
  // Workouts: union by id, minus anything deleted on either side.
  const deleted = new Set([...(out.deleted || []), ...((rc && Array.isArray(rc.deleted)) ? rc.deleted : [])]);
  const byId = new Map(out.sessions.map((x) => [x.id, x]));
  for (const [id, arr] of Object.entries(remote)) {
    if (!id.startsWith('sessions-') || !Array.isArray(arr)) continue;
    for (const x of arr) if (x && typeof x.id === 'string' && !byId.has(x.id)) byId.set(x.id, x);
  }
  out.sessions = [...byId.values()].filter((x) => !deleted.has(x.id));
  out.deleted = [...deleted].slice(-2000);
  // Settings, routines, plan: whichever side changed last wins.
  if (rc && (cloudWinsCore || (Number(rc.coreUpdatedAt) || 0) > (out.coreUpdatedAt || 0))) {
    for (const k of CORE_KEYS) if (k !== 'deleted' && rc[k] !== undefined) out[k] = rc[k];
    out.coreUpdatedAt = Number(rc.coreUpdatedAt) || 0;
  }
  if (rc) {
    out.badges = [...new Set([...(local.badges || []), ...(Array.isArray(rc.badges) ? rc.badges : [])])];
    out.notesSeen = [...new Set([...(local.notesSeen || []), ...(Array.isArray(rc.notesSeen) ? rc.notesSeen : [])])];
  }
  return out;
}
const hashOf = (str) => { let h1 = 5381; for (let i = 0; i < str.length; i++) h1 = ((h1 << 5) + h1 + str.charCodeAt(i)) | 0; return `${str.length}:${h1}`; };

function scheduleSync() {
  if (!cloud.auth || !cloudReady()) return;
  clearTimeout(cloud.timer);
  cloud.timer = setTimeout(() => syncNow({ pushOnly: true }), 3000);
}
async function syncNow(opts = {}) {
  if (!cloud.auth || !cloudReady() || !navigator.onLine) return;
  if (cloud.busy) { cloud.again = true; return; }
  cloud.busy = true;
  try {
    const st = syncState();
    if (!opts.pushOnly || !st.lastSync) {
      const remote = await pullChunks();
      const merged = normalize(mergeCloud(data, remote, !st.lastSync));
      merged.activeWorkout = data.activeWorkout; // in-progress workouts stay on this phone
      const changed = JSON.stringify(merged) !== JSON.stringify(data);
      data = merged;
      lastCoreJSON = JSON.stringify(coreOf(data));
      save({ fromSync: true });
      if (changed && !sheetState && !data.activeWorkout) render();
    }
    const chunks = toChunks(data);
    for (const id of Object.keys(st.hashes)) if (!(id in chunks)) chunks[id] = id.startsWith('sessions-') ? [] : (id === 'core' ? chunks.core : {});
    let pushed = 0;
    for (const [id, obj] of Object.entries(chunks)) {
      const hsh = hashOf(JSON.stringify(obj));
      if (st.hashes[id] === hsh) continue;
      await putChunk(id, obj);
      st.hashes[id] = hsh;
      pushed++;
    }
    st.lastSync = new Date().toISOString();
    writeSyncState(st);
    cloud.status = '';
  } catch (e) {
    console.error(e);
    cloud.status = e.message || 'Sync failed';
  } finally {
    cloud.busy = false;
    if (cloud.again) { cloud.again = false; syncNow({ pushOnly: true }); }
  }
}

function cloudCard() {
  if (!cloudReady()) return null;
  if (cloud.auth) {
    const st = syncState();
    return h('div', { class: 'card stack' },
      h('h2', null, '☁️ Cloud backup'),
      h('div', { class: 'small' }, `Signed in as ${cloud.auth.email || 'you'}.`),
      h('div', { class: 'small muted' }, cloud.status ? `⚠️ ${cloud.status}` : st.lastSync ? `Last synced ${new Date(st.lastSync).toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}. Saves automatically.` : 'Syncing…'),
      h('button', { class: 'btn block', onclick: async () => { await syncNow(); sheetState && sheetState.rerender(); toast(cloud.status ? cloud.status : 'Synced ✓'); } }, 'Sync now'),
      h('button', { class: 'btn danger block', onclick: () => { if (confirm('Sign out? Your data stays on this phone and in the cloud.')) { signOut(); sheetState && sheetState.rerender(); render(); } } }, 'Sign out'));
  }
  const f = cloudCard.form || (cloudCard.form = { email: '', password: '' });
  const go2 = (create) => async () => {
    const email = f.email.trim();
    if (!email || !f.password) { toast('Enter your email and a password.'); return; }
    try {
      await signIn(email, f.password, create);
      f.password = '';
      toast(create ? 'Cloud backup is on ☁️' : 'Signed in. Your data is synced ☁️');
      render();
      if (cloudCard.onDone) { const done = cloudCard.onDone; cloudCard.onDone = null; done(); } else if (sheetState) sheetState.rerender();
    } catch (e) { toast(e.message, 4000); }
  };
  return h('div', { class: 'card stack' },
    h('h2', null, '☁️ Cloud backup'),
    h('div', { class: 'small muted' }, 'Sign in once and your progress saves itself to your own private cloud folder. Sign in on a new phone to get everything back.'),
    h('input', { type: 'email', placeholder: 'Email', autocomplete: 'username', value: f.email, oninput: (ev) => { f.email = ev.target.value; } }),
    h('input', { type: 'password', placeholder: 'Password (6+ characters)', autocomplete: 'current-password', value: f.password, oninput: (ev) => { f.password = ev.target.value; } }),
    h('div', { class: 'grid2' },
      cloudCard.onDone
        ? [h('button', { class: 'btn primary', onclick: go2(true) }, 'Create account'), h('button', { class: 'btn', onclick: go2(false) }, 'Sign in')]
        : [h('button', { class: 'btn primary', onclick: go2(false) }, 'Sign in'), h('button', { class: 'btn', onclick: go2(true) }, 'Create account')]),
    h('button', { class: 'btn sm', onclick: async () => {
      if (!f.email.trim()) { toast('Type your email first.'); return; }
      try { await resetPassword(f.email.trim()); toast('Password reset email sent.'); } catch (e) { toast(e.message); }
    } }, 'Forgot password?'));
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
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { if (!sheetState) render(); syncNow(); } });
  window.addEventListener('online', () => syncNow());
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(console.error);
  lastCoreJSON = JSON.stringify(coreOf(data));
  render();
  importFromHash();
  syncNow();
  if (!data.askedName) {
    data.askedName = true; save();
    const st = { name: '' };
    openSheet('Welcome to RenStep 💗', () => h('div', { class: 'stack' },
      h('div', null, 'Steps, workouts and a coach that plans your next session for you. What should I call you?'),
      h('input', { type: 'text', maxlength: 30, placeholder: 'Your name', autocomplete: 'given-name', oninput: (ev) => { st.name = ev.target.value; } }),
      h('button', { class: 'btn primary block', onclick: () => { data.settings.name = str(st.name, 30); save(); render(); openPlanQuiz(); } }, "Let's go"),
      cloudReady() ? h('button', { class: 'btn block', onclick: () => { closeSheet(); openSettings(); } }, 'Already use RenStep? Sign in to restore') : null));
  }
  const fresh = syncBadges();
  if (fresh.length) toast(`Badge unlocked: ${fresh.map((b) => `${b.icon} ${b.name}`).join(', ')}`, 4000);
  if (data.askedName && !sheetState) showNotes(takeNotes(fresh.map((b) => b.id)));
}

boot();
