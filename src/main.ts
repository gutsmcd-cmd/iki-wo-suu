import './style.css'
import { askPersist, load, save } from './db'
import { dict, type Dict, type Lang } from './i18n'

const DB = 'iki-wo-suu'
const SPEED = Math.max(1, Number(new URLSearchParams(location.search).get('speed')) || 1) // dev/test only

type Pattern = 'power' | 'box' | 'p478' | 'calm' | 'custom'
type Pace = 'slow' | 'normal' | 'fast'
type Settings = {
  pattern: Pattern
  custom: [number, number, number, number]
  lenMode: 'min' | 'rounds'
  minutes: number
  rounds: number
  breaths: number
  pace: Pace
  powerRounds: number
  vibrate: boolean
  tone: boolean
  theme: 'dark' | 'light'
}
type PowerRec = { t: number; holds: number[] }
type History = { days: Record<string, number>; power: PowerRec[] }

const DEFAULTS: Settings = {
  pattern: 'power', custom: [4, 2, 6, 0], lenMode: 'min', minutes: 3, rounds: 10,
  breaths: 30, pace: 'normal', powerRounds: 3, vibrate: false, tone: false, theme: 'dark',
}
const PACE_SEC: Record<Pace, number> = { slow: 4, normal: 3, fast: 2 } // one full breath
const RECOVER_HOLD = 15
const RECOVER_IN = 3

let ui: Lang = 'ja'
let t: Dict = dict.ja
let S: Settings = { ...DEFAULTS }
let H: History = { days: {}, power: [] }
let safetyOk = false

const app = document.querySelector<HTMLDivElement>('#app')!

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text) n.textContent = text
  return n
}
function btn(cls: string, text: string, on: () => void): HTMLButtonElement {
  const b = el('button', cls, text)
  b.type = 'button'
  b.addEventListener('click', on)
  return b
}
const dayKey = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const fmt = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`
const persistS = () => void save(DB, 'settings', S)
const persistH = () => void save(DB, 'history', H)

// ---------- cues ----------
let actx: AudioContext | null = null
function cue(kind: 'in' | 'hold' | 'out' | 'tick') {
  if (S.vibrate && 'vibrate' in navigator) {
    try { navigator.vibrate(kind === 'tick' ? 15 : 40) } catch { /* ignore */ }
  }
  if (!S.tone) return
  try {
    actx ??= new AudioContext()
    const o = actx.createOscillator()
    const g = actx.createGain()
    o.type = 'sine'
    o.frequency.value = { in: 440, hold: 392, out: 330, tick: 523 }[kind]
    const now = actx.currentTime
    g.gain.setValueAtTime(0, now)
    g.gain.linearRampToValueAtTime(kind === 'tick' ? 0.04 : 0.08, now + 0.05)
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.9)
    o.connect(g).connect(actx.destination)
    o.start(now)
    o.stop(now + 1)
  } catch { /* ignore */ }
}

// ---------- wake lock ----------
let lock: WakeLockSentinel | null = null
async function wake(on: boolean) {
  try {
    if (on && 'wakeLock' in navigator && document.visibilityState === 'visible') lock = await navigator.wakeLock.request('screen')
    else if (!on && lock) { await lock.release(); lock = null }
  } catch { /* ignore */ }
}
document.addEventListener('visibilitychange', () => { if (running && document.visibilityState === 'visible') void wake(true) })

// ---------- home ----------
function render() {
  document.documentElement.lang = ui
  document.documentElement.dataset.theme = S.theme
  document.title = t.app
  app.replaceChildren()

  const top = el('header', 'top')
  const titleBox = el('div')
  titleBox.append(el('h1', 'title', t.app), el('p', 'lead', t.lead))
  const tools = el('div', 'tools')
  tools.append(
    btn('pill', S.theme === 'dark' ? t.light : t.dark, () => { S.theme = S.theme === 'dark' ? 'light' : 'dark'; persistS(); render() }),
    btn('pill lang', t.toggle, () => { ui = ui === 'ja' ? 'en' : 'ja'; t = dict[ui]; void save(DB, 'ui', ui); render() }),
  )
  top.append(titleBox, tools)

  const main = el('main', 'home')
  // Primary: power breathing
  const power = el('section', 'card' + (S.pattern === 'power' ? ' on' : ''))
  const ph = btn('mode primary-mode', '', () => { S.pattern = 'power'; persistS(); render() })
  ph.dataset.pattern = 'power'
  ph.append(el('span', 'mode-main', t.power), el('span', 'mode-sub', t.powerSub))
  power.append(ph)
  if (S.pattern === 'power') {
    power.append(
      seg(t.breaths, [20, 30, 40].map((n) => [String(n), String(n), S.breaths === n, () => { S.breaths = n }])),
      seg(t.pace, (['slow', 'normal', 'fast'] as Pace[]).map((p) => [p, t.paces[p], S.pace === p, () => { S.pace = p }])),
      seg(t.powerRounds, [1, 2, 3, 4, 5].map((n) => [String(n), String(n), S.powerRounds === n, () => { S.powerRounds = n }])),
    )
  }
  main.append(power)

  // Secondary patterns
  const other = el('section', 'card' + (S.pattern !== 'power' ? ' on' : ''))
  other.append(el('p', 'label', t.others))
  const modes = el('div', 'modes')
  for (const p of ['box', 'p478', 'calm', 'custom'] as const) {
    const b = btn('mode' + (S.pattern === p ? ' sel' : ''), t.patterns[p], () => { S.pattern = p; persistS(); render() })
    b.dataset.pattern = p
    modes.append(b)
  }
  other.append(modes)
  if (S.pattern === 'custom') {
    other.append(el('p', 'label', t.customH))
    const row = el('div', 'custom')
    const names = [t.in, t.hold, t.out, t.hold]
    S.custom.forEach((v, i) => {
      const f = el('label', 'num')
      f.append(el('span', '', names[i]))
      const inp = el('input')
      inp.type = 'number'; inp.min = i === 0 || i === 2 ? '1' : '0'; inp.max = '20'; inp.value = String(v)
      inp.dataset.i = String(i)
      inp.addEventListener('change', () => {
        const n = Math.round(Number(inp.value))
        S.custom[i] = Math.min(20, Math.max(Number(inp.min), Number.isFinite(n) ? n : 0))
        inp.value = String(S.custom[i]); persistS()
      })
      f.append(inp); row.append(f)
    })
    other.append(row)
  }
  if (S.pattern !== 'power') {
    other.append(seg(t.length, [
      ['min', t.byTime, S.lenMode === 'min', () => { S.lenMode = 'min' }],
      ['rounds', t.byRounds, S.lenMode === 'rounds', () => { S.lenMode = 'rounds' }],
    ]))
    if (S.lenMode === 'min') other.append(seg('', [1, 3, 5, 10].map((n) => [String(n), `${n} ${t.min}`, S.minutes === n, () => { S.minutes = n }])))
    else other.append(seg('', [5, 10, 20, 30].map((n) => [String(n), `${n} ${t.rounds}`, S.rounds === n, () => { S.rounds = n }])))
  }
  main.append(other)

  const opts = el('section', 'card')
  opts.append(toggle(t.vibrate, S.vibrate, (v) => { S.vibrate = v }, 'vibrate'), toggle(t.tone, S.tone, (v) => { S.tone = v }, 'tone'))
  main.append(opts)

  const start = btn('big primary start', t.start, () => begin())
  start.id = 'start'
  main.append(start)
  if (S.pattern === 'power') main.append(el('p', 'safety-note', '⚠︎ ' + t.safetyNote))

  main.append(stats())
  const foot = el('footer', 'foot')
  foot.append(el('p', 'note', t.note), el('p', '', t.foot))
  app.append(top, main, foot)
}

type Opt = [string, string, boolean, () => void]
function seg(label: string, opts: Opt[]) {
  const w = el('div', 'seg-wrap')
  if (label) w.append(el('p', 'label', label))
  const s = el('div', 'seg')
  for (const [k, text, on, fn] of opts) {
    const b = btn('seg-b' + (on ? ' on' : ''), text, () => { fn(); persistS(); render() })
    b.dataset.k = k
    s.append(b)
  }
  w.append(s)
  return w
}
function toggle(label: string, on: boolean, fn: (v: boolean) => void, id: string) {
  const l = el('label', 'tog')
  const c = el('input')
  c.type = 'checkbox'; c.checked = on; c.id = id
  c.addEventListener('change', () => { fn(c.checked); persistS() })
  l.append(c, el('span', '', label))
  return l
}

function stats() {
  const s = el('section', 'card stats')
  const today = H.days[dayKey()] ?? 0
  let streak = 0
  const d = new Date()
  if (!H.days[dayKey(d)]) d.setDate(d.getDate() - 1)
  while (H.days[dayKey(d)]) { streak++; d.setDate(d.getDate() - 1) }
  const nums = el('div', 'nums')
  const a = el('div', 'stat'); a.id = 'today'
  a.append(el('span', 'k', t.today), el('b', '', String(Math.round(today / 60))), el('span', 'u', t.todayUnit))
  const b = el('div', 'stat'); b.id = 'streak'
  b.append(el('span', 'k', t.streak), el('b', '', String(streak)), el('span', 'u', t.streakUnit))
  nums.append(a, b)
  const week = el('div', 'week')
  week.setAttribute('aria-label', t.week)
  for (let i = 6; i >= 0; i--) {
    const x = new Date(); x.setDate(x.getDate() - i)
    const dot = el('span', 'dot' + (H.days[dayKey(x)] ? ' on' : ''))
    dot.title = dayKey(x)
    week.append(dot)
  }
  s.append(nums, el('p', 'label', t.week), week)
  if (H.power.length) {
    const all = H.power.flatMap((p) => p.holds)
    const best = Math.max(...all)
    const avg = all.reduce((x, y) => x + y, 0) / all.length
    const ph = el('div', 'power-stats')
    ph.id = 'power-stats'
    ph.append(el('p', 'label', `${t.power} · ${t.holds}`),
      el('p', 'pbest', `${t.best} ${fmt(best)}  ·  ${t.avg} ${fmt(avg)}`))
    const ul = el('ul', 'plist')
    for (const r of H.power.slice(-5).reverse()) {
      const dt = new Date(r.t)
      ul.append(el('li', '', `${dt.getMonth() + 1}/${dt.getDate()}  ${r.holds.map(fmt).join(' · ')}`))
    }
    ph.append(ul); s.append(ph)
  }
  return s
}

// ---------- session view ----------
const view = el('div', 'session')
view.hidden = true
const circleWrap = el('div', 'circle-wrap')
const circle = el('div', 'circle')
const phaseText = el('p', 'phase')
const bigNum = el('p', 'bignum')
const subText = el('p', 'sub')
circleWrap.append(circle)
const center = el('div', 'center')
center.append(phaseText, bigNum)
circleWrap.append(center)
const actBtn = btn('big primary act', '', () => onAct())
const stopBtn = btn('big stop', '', () => finish(true))
const bar = el('div', 'bar')
bar.append(actBtn, stopBtn)
const summary = el('div', 'summary')
view.append(circleWrap, subText, summary, bar)
document.body.append(view)
circleWrap.addEventListener('click', () => { if (pw && pw.stage === 'hold') onAct() })

let running = false
let timer = 0
let sessionStart = 0
let lastTickCue = -1
const now = () => performance.now() * SPEED / 1000

function setCircle(scale: number, sec: number) {
  circle.style.transition = `transform ${Math.max(0.05, sec / SPEED)}s ease-in-out`
  circle.style.transform = `scale(${scale})`
}
function setPhase(kind: string, label: string) {
  circle.dataset.phase = kind
  view.dataset.phase = kind
  phaseText.textContent = label
}

// classic engine
type Ph = { kind: 'in' | 'hold' | 'out'; sec: number }
let cl: { phases: Ph[]; idx: number; start: number; round: number; maxRounds: number; endAt: number } | null = null
function classicPhases(): Ph[] {
  const c: [number, number, number, number] =
    S.pattern === 'box' ? [4, 4, 4, 4] : S.pattern === 'p478' ? [4, 7, 8, 0] : S.pattern === 'calm' ? [4, 0, 6, 0] : S.custom
  const k: Ph['kind'][] = ['in', 'hold', 'out', 'hold']
  return c.map((sec, i) => ({ kind: k[i], sec })).filter((p) => p.sec > 0)
}
function enterClassic(i: number) {
  if (!cl) return
  cl.idx = i
  cl.start = now()
  const p = cl.phases[i]
  setPhase(p.kind, t[p.kind])
  if (p.kind === 'in') setCircle(1, p.sec)
  else if (p.kind === 'out') setCircle(0.45, p.sec)
  cue(p.kind)
}

// power engine
let pw: { stage: 'breath' | 'hold' | 'recover-in' | 'recover' | 'done'; round: number; breath: number; half: number; start: number; holds: number[] } | null = null
function powerBreath(n: number, half: 0 | 1) {
  if (!pw) return
  pw.stage = 'breath'; pw.breath = n; pw.half = half; pw.start = now()
  const B = PACE_SEC[S.pace]
  setPhase(half === 0 ? 'in' : 'out', t.deep)
  setCircle(half === 0 ? 1 : 0.55, B / 2)
  if (half === 0) cue('tick')
}
function powerHold() {
  if (!pw) return
  pw.stage = 'hold'; pw.start = now()
  setPhase('hold', t.holdOut)
  setCircle(0.4, 1.5)
  cue('out')
}
function powerRecover() {
  if (!pw) return
  pw.stage = 'recover-in'; pw.start = now()
  setPhase('in', t.recover)
  setCircle(1, RECOVER_IN)
  cue('in')
}

function begin() {
  if (S.pattern === 'power' && !safetyOk) return showSafety()
  try { if (S.tone) { actx ??= new AudioContext(); void actx.resume() } } catch { /* ignore */ }
  running = true
  sessionStart = now()
  lastTickCue = -1
  view.hidden = false
  summary.replaceChildren(); summary.hidden = true
  circleWrap.hidden = false
  subText.textContent = ''
  stopBtn.textContent = t.stop
  stopBtn.hidden = false
  document.body.classList.add('noscroll')
  circle.style.transition = 'none'
  circle.style.transform = 'scale(0.45)'
  void circle.offsetWidth
  void wake(true)
  if (S.pattern === 'power') {
    cl = null
    pw = { stage: 'breath', round: 1, breath: 1, half: 0, start: 0, holds: [] }
    actBtn.hidden = true
    powerBreath(1, 0)
  } else {
    pw = null
    const phases = classicPhases()
    const cycle = phases.reduce((a, p) => a + p.sec, 0)
    cl = {
      phases, idx: 0, start: 0, round: 1,
      maxRounds: S.lenMode === 'rounds' ? S.rounds : Math.max(1, Math.round((S.minutes * 60) / cycle)),
      endAt: 0,
    }
    actBtn.hidden = true
    enterClassic(0)
  }
  clearInterval(timer)
  timer = window.setInterval(tick, 50)
  tick()
}

function tick() {
  if (!running) return
  const n = now()
  if (cl) {
    const p = cl.phases[cl.idx]
    const el2 = n - cl.start
    const left = Math.max(0, p.sec - el2)
    bigNum.textContent = String(Math.ceil(left - 1e-6) || 1)
    subText.textContent = `${ui === 'ja' ? `${cl.round}${t.round}` : `${t.round} ${cl.round}`} / ${cl.maxRounds}`
    if (el2 >= p.sec) {
      if (cl.idx + 1 < cl.phases.length) enterClassic(cl.idx + 1)
      else if (cl.round < cl.maxRounds) { cl.round++; enterClassic(0) }
      else finish(false)
    }
  } else if (pw) {
    const el2 = n - pw.start
    const B = PACE_SEC[S.pace]
    subText.textContent = `${ui === 'ja' ? `ラウンド ${pw.round}` : `Round ${pw.round}`} / ${S.powerRounds}`
    if (pw.stage === 'breath') {
      bigNum.textContent = String(pw.breath)
      if (el2 >= B / 2) {
        if (pw.half === 0) powerBreath(pw.breath, 1)
        else if (pw.breath < S.breaths) powerBreath(pw.breath + 1, 0)
        else powerHold()
      }
    } else if (pw.stage === 'hold') {
      bigNum.textContent = fmt(el2)
      actBtn.hidden = false
      actBtn.textContent = t.tapBreathe
      const m = Math.floor(el2 / 30)
      if (m > 0 && m !== lastTickCue) { lastTickCue = m; cue('tick') }
    } else if (pw.stage === 'recover-in') {
      bigNum.textContent = ''
      if (el2 >= RECOVER_IN) { pw.stage = 'recover'; pw.start = now(); setPhase('hold', t.recover); cue('hold') }
    } else if (pw.stage === 'recover') {
      bigNum.textContent = String(Math.ceil(RECOVER_HOLD - el2) || 1)
      if (el2 >= RECOVER_HOLD) {
        cue('out')
        if (pw.round < S.powerRounds) { pw.round++; lastTickCue = -1; powerBreath(1, 0) }
        else finish(false)
      }
    }
  }
}

function onAct() {
  if (!pw) return
  if (pw.stage === 'hold') {
    pw.holds.push(Math.round((now() - pw.start) * 10) / 10)
    actBtn.hidden = true
    powerRecover()
  }
}

function finish(stopped: boolean) {
  if (!running) return
  running = false
  clearInterval(timer)
  void wake(false)
  const secs = Math.round(now() - sessionStart)
  if (secs > 0) { const k = dayKey(); H.days[k] = (H.days[k] ?? 0) + secs }
  const holds = pw?.holds ?? []
  if (holds.length) H.power.push({ t: Date.now(), holds })
  if (H.power.length > 100) H.power = H.power.slice(-100)
  persistH()
  cl = null; pw = null
  if (stopped && !holds.length) return closeView()
  circleWrap.hidden = true
  subText.textContent = ''
  summary.hidden = false
  summary.replaceChildren(el('h2', 'done', t.done))
  if (holds.length) {
    summary.append(el('p', 'label', t.holds))
    const ol = el('ol', 'holds')
    ol.id = 'holds'
    holds.forEach((h) => ol.append(el('li', '', fmt(h))))
    summary.append(ol)
  }
  actBtn.hidden = false
  actBtn.textContent = ui === 'ja' ? 'もどる' : 'Back'
  actBtn.onclick = () => { actBtn.onclick = null; closeView() }
  stopBtn.hidden = true
}
function closeView() {
  view.hidden = true
  actBtn.onclick = null
  document.body.classList.remove('noscroll')
  render()
}

// ---------- safety ----------
function showSafety() {
  const o = el('div', 'safety')
  o.id = 'safety'
  const box = el('div', 'safety-box')
  box.append(el('h2', '', '⚠︎ ' + t.safetyH))
  const ul = el('ul')
  t.safety.forEach((s) => ul.append(el('li', '', s)))
  box.append(ul, btn('big primary', t.safetyOk, () => { safetyOk = true; void save(DB, 'safetyOk', true); o.remove(); begin() }),
    btn('big', ui === 'ja' ? 'もどる' : 'Back', () => o.remove()))
  o.append(box)
  document.body.append(o)
}

// ---------- boot ----------
async function boot() {
  const [l, s, h, ok] = await Promise.all([
    load<Lang>(DB, 'ui'), load<Partial<Settings>>(DB, 'settings'), load<History>(DB, 'history'), load<boolean>(DB, 'safetyOk'),
  ])
  if (l === 'en' || l === 'ja') { ui = l; t = dict[ui] }
  if (s) S = { ...DEFAULTS, ...s }
  if (h) H = { days: h.days ?? {}, power: h.power ?? [] }
  safetyOk = ok === true
  render()
  void askPersist()
}
render()
void boot()
