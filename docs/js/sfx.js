// Small synthesized sounds (no files to download). Quiet by default, can be muted from the menu.
let ctx = null;
let on = true;
try { on = localStorage.getItem('rummy_sound') !== 'off'; } catch (e) { /* storage blocked */ }

function ac() {
  if (!ctx) { const C = window.AudioContext || window.webkitAudioContext; if (!C) return null; ctx = new C(); }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}
export function unlock() { try { ac(); } catch (e) { /* ignore */ } }
export function isOn() { return on; }
export function toggle() {
  on = !on;
  try { localStorage.setItem('rummy_sound', on ? 'on' : 'off'); } catch (e) { /* ignore */ }
  return on;
}

function noise(dur, freq, q, vol, when = 0) {
  const a = ac(); if (!a) return;
  const t = a.currentTime + when;
  const len = Math.floor(a.sampleRate * dur), buf = a.createBuffer(1, len, a.sampleRate), d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2);
  const src = a.createBufferSource(); src.buffer = buf;
  const f = a.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = q;
  const gn = a.createGain(); gn.gain.value = vol;
  src.connect(f); f.connect(gn); gn.connect(a.destination); src.start(t);
}
function tone(freq, dur, vol, when = 0, type = 'sine') {
  const a = ac(); if (!a) return;
  const t = a.currentTime + when;
  const o = a.createOscillator(); o.type = type; o.frequency.value = freq;
  const gn = a.createGain(); gn.gain.setValueAtTime(0.0001, t); gn.gain.exponentialRampToValueAtTime(vol, t + 0.015);
  gn.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(gn); gn.connect(a.destination); o.start(t); o.stop(t + dur + 0.05);
}

export function play(name) {
  if (!on) return;
  try {
    if (name === 'draw') noise(0.09, 2400, 0.9, 0.5);
    else if (name === 'place') { noise(0.07, 900, 0.8, 0.6); noise(0.05, 300, 1, 0.4, 0.02); }
    else if (name === 'shuffle') { for (let i = 0; i < 9; i++) noise(0.06, 1800 + Math.random() * 900, 0.8, 0.35, i * 0.045); }
    else if (name === 'turn') { tone(660, 0.18, 0.12); tone(990, 0.25, 0.1, 0.09); }
    else if (name === 'win') { [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.45, 0.14, i * 0.12, 'triangle')); }
    else if (name === 'click') tone(1200, 0.05, 0.05);
  } catch (e) { /* sound must never break the game */ }
}
