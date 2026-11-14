// Rummy tiles, drawn in code so numbers are always exact.
// Tile id: 0..103 = two sets (colour = (id%52)/13: 0 red, 1 blue, 2 orange, 3 black; number = id%13+1), 104..105 jokers.
export const W = 192, H = 256;
const COLORS = ['#d3172b', '#1d4fae', '#f07a12', '#161616'];
const COLOR_NAMES = ['אדום', 'כחול', 'כתום', 'שחור'];

export const isJoker = (c) => c >= 104;
export const suitOf = (c) => (c >= 104 ? -1 : Math.floor((c % 52) / 13));
export const rankOf = (c) => (c >= 104 ? 0 : (c % 13) + 1);
export const faceKey = (c) => (c >= 104 ? 'J' + (c % 2) : String(c % 52));
export const colorName = (c) => (c >= 104 ? "ג'וקר" : COLOR_NAMES[suitOf(c)]);

export function loadImages() { return Promise.resolve(); }   // tiles need no pictures

function roundRect(g, x, y, w, h, r) {
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}

// cream tile body with a soft bevel
function body(g) {
  const grd = g.createLinearGradient(0, 0, 0, H);
  grd.addColorStop(0, '#fbf4e2'); grd.addColorStop(0.55, '#f3e7c9'); grd.addColorStop(1, '#e2d1a8');
  roundRect(g, 3, 3, W - 6, H - 6, 26); g.fillStyle = grd; g.fill();
  g.lineWidth = 4; g.strokeStyle = 'rgba(120, 95, 50, .45)'; g.stroke();
  roundRect(g, 10, 10, W - 20, H - 20, 20); g.lineWidth = 2; g.strokeStyle = 'rgba(255,255,255,.7)'; g.stroke();
}

// the small engraved circle under the number
function dimple(g, y) {
  g.beginPath(); g.arc(W / 2, y, 24, 0, Math.PI * 2);
  g.fillStyle = 'rgba(0,0,0,.05)'; g.fill();
  g.lineWidth = 3.5; g.strokeStyle = 'rgba(140,110,60,.55)'; g.stroke();
  g.beginPath(); g.arc(W / 2, y + 1.5, 21, 0.15 * Math.PI, 0.85 * Math.PI); g.strokeStyle = 'rgba(255,255,255,.75)'; g.lineWidth = 2; g.stroke();
}

function smiley(g, color) {
  const cx = W / 2, cy = 100, r = 54;
  g.lineWidth = 6; g.strokeStyle = color;
  g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.stroke();
  g.fillStyle = color;
  g.beginPath(); g.ellipse(cx - 20, cy - 12, 8, 6, 0, 0, Math.PI * 2); g.fill();
  g.beginPath(); g.ellipse(cx + 20, cy - 12, 8, 6, 0, 0, Math.PI * 2); g.fill();
  g.lineWidth = 5; g.beginPath(); g.arc(cx, cy + 4, 28, 0.15 * Math.PI, 0.85 * Math.PI); g.stroke();
  g.lineWidth = 4; g.beginPath(); g.moveTo(cx, cy - 4); g.lineTo(cx - 5, cy + 10); g.lineTo(cx + 3, cy + 10); g.stroke();
}

const faceCache = {};
export function faceCanvas(c) {
  const key = faceKey(c);
  if (faceCache[key]) return faceCache[key];
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  body(g);
  if (isJoker(c)) {
    smiley(g, c % 2 ? '#d3172b' : '#161616');
  } else {
    const n = rankOf(c);
    g.fillStyle = COLORS[suitOf(c)];
    g.font = `900 ${n >= 10 ? 104 : 124}px Heebo, "Arial Black", Arial, sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'alphabetic';
    g.save(); g.shadowColor = 'rgba(0,0,0,.25)'; g.shadowOffsetY = 2; g.shadowBlur = 1;
    if (n >= 10) { g.save(); g.translate(W / 2, 148); g.scale(0.86, 1); g.fillText(String(n), 0, 0); g.restore(); }
    else g.fillText(String(n), W / 2, 150);
    g.restore();
    if (n === 6 || n === 9) { g.fillRect(W / 2 - 22, 160, 44, 7); }      // marks 6 / 9 so they are not confused
  }
  dimple(g, 205);
  faceCache[key] = cv;
  return cv;
}

const urlCache = {};
export function faceURL(c) {
  const key = faceKey(c);
  if (!urlCache[key]) urlCache[key] = faceCanvas(c).toDataURL('image/png');
  return urlCache[key];
}

let backCv;
export function backCanvas() {
  if (backCv) return backCv;
  backCv = document.createElement('canvas'); backCv.width = W; backCv.height = H;
  body(backCv.getContext('2d'));
  return backCv;
}

// sorting helpers for the rack
export function sortBySuit(hand) {
  return [...hand].sort((a, b) => (isJoker(a) - isJoker(b)) || (suitOf(a) - suitOf(b)) || (rankOf(a) - rankOf(b)) || (a - b));
}
export function sortByRank(hand) {
  return [...hand].sort((a, b) => (isJoker(a) - isJoker(b)) || (rankOf(a) - rankOf(b)) || (suitOf(a) - suitOf(b)) || (a - b));
}
