// ================================================================
// foggy glass
// 입 벌림 → 서리 / 검지 손가락으로 낙서 → 자국 따라 흘러내림
// ================================================================

let capture;
let cnv;
let fogG;       // 서리 누적 레이어 (erase 없음)
let eraseG;     // 손가락/드립 자국 레이어 (hard mask)
let blurBuf;    // 블러 처리된 카메라
let softFogBuf; // fogG를 gaussian blur로 부드럽게 만든 마스크
let fogOpacity  = 0;
let wasFoggy    = false;
let drips       = [];
let strokePts   = [];

// 손가락 추적
let fingerX = 0, fingerY = 0;
let fingerActive     = false;
window.handTrackingEnabled = false; // 기본값: OFF
let prevFingerActive = false;
let prevFingerDrawX, prevFingerDrawY;

// 입 위치 + 열림 감지
let mouthX = -1, mouthY = -1;
let faceDetected  = false;
let mouthOpen     = false;
let mouthFogRadius = 80;

const FOG_DECAY = 1 / (28 * 60);
const BRUSH_R   = 18;

function calcSize() {
  const el = document.getElementById('camera-overlay');
  return { w: floor(el.offsetWidth), h: floor(el.offsetHeight) };
}

let prevDragX, prevDragY;

// ================================================================
// setup / draw
// ================================================================
function setup() {
  const sz = calcSize();
  cnv = createCanvas(sz.w, sz.h);
  cnv.parent('camera-overlay');
  pixelDensity(1);

  capture = createCapture(VIDEO);
  capture.size(640, 480);
  capture.hide();

  fogG       = createGraphics(sz.w, sz.h);
  eraseG     = createGraphics(sz.w, sz.h);
  blurBuf    = createGraphics(sz.w, sz.h);
  softFogBuf = createGraphics(sz.w, sz.h);
  fogG.pixelDensity(1);
  eraseG.pixelDensity(1);
  blurBuf.pixelDensity(1);
  softFogBuf.pixelDensity(1);

  noStroke();
  setupHands();
  setupFaceMesh();

  document.getElementById('capture-btn').addEventListener('click', () => {
    try {
      const dataUrl = cnv.elt.toDataURL('image/png');
      const img = document.createElement('img');
      img.className = 'strip-thumb';
      img.src = dataUrl;
      const strip = document.getElementById('photo-strip');
      strip.appendChild(img);
      strip.scrollLeft = strip.scrollWidth;
    } catch (e) {}
    saveCanvas('foggy-glass', 'png');
  });
}

function draw() {
  // 1. 웹캠 배경 (거울)
  drawCamera();

  // 2. 입 벌림으로 서리 제어
  handleBreath();

  // 3. 손가락으로 서리 지우기 (선명하게, eraseG에 기록)
  if (fingerActive && fogOpacity > 0.05) {
    if (prevFingerDrawX !== undefined) {
      interpolatedErase(prevFingerDrawX, prevFingerDrawY, fingerX, fingerY, strokePts);
    } else {
      stampErase(fingerX, fingerY);
      strokePts.push({ x: fingerX, y: fingerY });
    }
    prevFingerDrawX = fingerX;
    prevFingerDrawY = fingerY;
  }
  if (!fingerActive && prevFingerActive) {
    prevFingerDrawX = undefined;
    prevFingerDrawY = undefined;
    spawnDrips(strokePts);
    strokePts = [];
  }
  prevFingerActive = fingerActive;

  // 4. 서리 렌더링
  if (fogOpacity > 0.01) {
    // (A) softFogBuf: fogG를 gaussian blur로 부드럽게 (서리 경계 softening)
    softFogBuf.clear();
    softFogBuf.drawingContext.filter = 'blur(24px)';
    softFogBuf.image(fogG, 0, 0);
    softFogBuf.drawingContext.filter = 'none';

    // (B) eraseG를 destination-out으로 적용 → 자국은 선명하게 뚫림
    softFogBuf.drawingContext.globalCompositeOperation = 'destination-out';
    softFogBuf.image(eraseG, 0, 0);
    softFogBuf.drawingContext.globalCompositeOperation = 'source-over';

    // (C) blurBuf: 카메라를 강하게 블러 → softFogBuf로 마스킹
    blurBuf.clear();
    blurBuf.drawingContext.filter = 'blur(10px)';
    drawCameraTo(blurBuf);
    blurBuf.drawingContext.filter = 'none';
    blurBuf.drawingContext.globalCompositeOperation = 'destination-in';
    blurBuf.image(softFogBuf, 0, 0);
    blurBuf.drawingContext.globalCompositeOperation = 'source-over';

    // (D) frosted backdrop 합성
    tint(255, fogOpacity * 255);
    image(blurBuf, 0, 0);
    noTint();

    // (E) 흰 서리 레이어
    tint(255, fogOpacity * 255);
    image(softFogBuf, 0, 0);
    noTint();
  }

  // 5. 드립 업데이트
  for (let i = drips.length - 1; i >= 0; i--) {
    drips[i].update();
    drips[i].render();
    if (drips[i].dead) drips.splice(i, 1);
  }

  // 6. 커서
  drawCursor();

  // 7. 로딩 표시 (얼굴 인식 모델 다운로드 전)
  if (!faceDetected) drawLoading();
}

function drawLoading() {
  const lines = ['서리 준비중...', '조금만 기다려주세요.', '이 문구가 사라지면 시작할 수 있어요.'];
  textSize(13);
  textAlign(CENTER, CENTER);
  const lineH = 20;
  const pad = 16;
  const boxH = lines.length * lineH + pad;
  const boxW = 260;
  fill(0, 0, 0, 120);
  noStroke();
  rect(width / 2 - boxW / 2, height / 2 - boxH / 2, boxW, boxH, 8);
  fill(255, 255, 255, 160);
  for (let i = 0; i < lines.length; i++) {
    text(lines[i], width / 2, height / 2 - (lines.length - 1) * lineH / 2 + i * lineH);
  }
  textAlign(LEFT, BASELINE);
}

function windowResized() {
  const sz = calcSize();
  resizeCanvas(sz.w, sz.h);
  fogG       = createGraphics(sz.w, sz.h);
  eraseG     = createGraphics(sz.w, sz.h);
  blurBuf    = createGraphics(sz.w, sz.h);
  softFogBuf = createGraphics(sz.w, sz.h);
  fogG.pixelDensity(1);
  eraseG.pixelDensity(1);
  blurBuf.pixelDensity(1);
  softFogBuf.pixelDensity(1);
}

// ================================================================
// 웹캠 커버핏 (좌우 반전)
// ================================================================
function drawCamera()    { drawCameraTo(null); }
function drawCameraTo(g) {
  if (!capture || capture.width === 0) {
    if (g) { g.background(10, 14, 30); } else { background(10, 14, 30); }
    return;
  }
  const vw = capture.width, vh = capture.height;
  const va = vw / vh, ca = width / height;
  let sx, sy, sw, sh;
  if (ca > va) {
    sw = vw; sh = vw / ca; sx = 0;       sy = (vh - sh) / 2;
  } else {
    sh = vh; sw = vh * ca; sy = 0;       sx = (vw - sw) / 2;
  }
  if (g) {
    g.push();
    g.translate(width, 0); g.scale(-1, 1);
    g.image(capture, 0, 0, width, height, sx, sy, sw, sh);
    g.pop();
  } else {
    push();
    translate(width, 0); scale(-1, 1);
    image(capture, 0, 0, width, height, sx, sy, sw, sh);
    pop();
  }
}

// ================================================================
// 서리 제어
// ================================================================
function handleBreath() {
  if (faceDetected && mouthOpen) {
    addBreathFog(mouthX, mouthY, mouthFogRadius);
    fogOpacity = min(0.72, fogOpacity + 0.018);
    wasFoggy = true;
  } else {
    fogOpacity = max(0, fogOpacity - FOG_DECAY);
    if (wasFoggy && fogOpacity === 0) {
      fogG.clear();
      eraseG.clear();
      drips     = [];
      strokePts = [];
      wasFoggy  = false;
    }
  }
}

function addBreathFog(cx, cy, r) {
  const ctx  = fogG.drawingContext;
  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  grad.addColorStop(0.0,  'rgba(255,255,255,0.08)');
  grad.addColorStop(0.4,  'rgba(255,255,255,0.05)');
  grad.addColorStop(0.75, 'rgba(255,255,255,0.02)');
  grad.addColorStop(1.0,  'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
}

function keyPressed() {
  if (key === ' ') {
    const cx = faceDetected ? mouthX : width / 2;
    const cy = faceDetected ? mouthY : height * 0.68;
    const r  = faceDetected ? mouthFogRadius : 100;
    for (let i = 0; i < 40; i++) addBreathFog(cx, cy, r);
    fogOpacity = 0.72;
    wasFoggy   = true;
  }
}

// ================================================================
// 서리 지우기 — eraseG에 선명하게 그림 (fogG는 건드리지 않음)
// ================================================================
function stampErase(x, y) {
  eraseG.fill(255);
  eraseG.noStroke();
  eraseG.ellipse(x, y, BRUSH_R * 2,   BRUSH_R * 2);
  eraseG.ellipse(x, y, BRUSH_R * 1.3, BRUSH_R * 1.3);
}

function interpolatedErase(x0, y0, x1, y1, pts) {
  const d     = dist(x0, y0, x1, y1);
  const steps = max(1, ceil(d / (BRUSH_R * 0.5)));
  for (let i = 1; i <= steps; i++) {
    const t  = i / steps;
    const ix = lerp(x0, x1, t);
    const iy = lerp(y0, y1, t);
    stampErase(ix, iy);
    if (i % 2 === 0) pts.push({ x: ix, y: iy });
  }
}

function spawnDrips(pts) {
  if (pts.length === 0) return;
  for (const pt of pts) {
    if (random() < 0.15) {
      drips.push(new Drip(pt.x, pt.y, random(60, 1600)));
    }
  }
}

// ================================================================
// 마우스 폴백
// ================================================================
function mouseDragged() {
  if (fingerActive || fogOpacity < 0.05) return;
  if (prevDragX !== undefined) {
    interpolatedErase(prevDragX, prevDragY, mouseX, mouseY, strokePts);
  } else {
    stampErase(mouseX, mouseY);
    strokePts.push({ x: mouseX, y: mouseY });
  }
  prevDragX = mouseX;
  prevDragY = mouseY;
}

function mouseReleased() {
  if (fingerActive) return;
  spawnDrips(strokePts);
  strokePts  = [];
  prevDragX  = undefined;
  prevDragY  = undefined;
}

function touchMoved() { mouseDragged(); return false; }
function touchEnded() { mouseReleased(); return false; }

// ================================================================
// 커서
// ================================================================
function drawCursor() {
  if (fogOpacity < 0.05) return;
  const x = fingerActive ? fingerX : mouseX;
  const y = fingerActive ? fingerY : mouseY;
  noFill();
  stroke(255, 255, 255, fingerActive ? 100 : 55);
  strokeWeight(fingerActive ? 1.5 : 1);
  circle(x, y, BRUSH_R * 2);
  noStroke();
}

// ================================================================
// MediaPipe Hands — 검지 손가락
// ================================================================
function setupHands() {
  if (typeof Hands === 'undefined') return;
  const hands = new Hands({
    locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${f}`
  });
  hands.setOptions({
    maxNumHands: 1,
    modelComplexity: 1,
    minDetectionConfidence: 0.7,
    minTrackingConfidence: 0.5,
  });
  hands.onResults(results => {
    if (!window.handTrackingEnabled) { fingerActive = false; return; }
    if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
      const lm  = results.multiHandLandmarks[0];
      const tip = lm[8], pip = lm[6];
      const extended = tip.y < pip.y;
      fingerActive = extended;
      if (extended) {
        fingerX = (1 - tip.x) * width;
        fingerY = tip.y * height;
      }
    } else {
      fingerActive = false;
    }
  });
  async function sendFrame() {
    if (capture && capture.elt.readyState >= 2)
      await hands.send({ image: capture.elt });
    requestAnimationFrame(sendFrame);
  }
  setTimeout(sendFrame, 1000);
}

// ================================================================
// MediaPipe Face Mesh — 입 위치 + 입 벌림 감지
// ================================================================
function setupFaceMesh() {
  if (typeof FaceMesh === 'undefined') return;
  const faceMesh = new FaceMesh({
    locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${f}`
  });
  faceMesh.setOptions({
    maxNumFaces: 1,
    refineLandmarks: false,
    minDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  faceMesh.onResults(results => {
    if (results.multiFaceLandmarks && results.multiFaceLandmarks.length > 0) {
      const lm = results.multiFaceLandmarks[0];

      const mx = (lm[13].x + lm[14].x) / 2;
      const my = (lm[13].y + lm[14].y) / 2;
      mouthX   = (1 - mx) * width;
      mouthY   = my * height;

      const openAmount = abs(lm[14].y - lm[13].y);
      mouthOpen = openAmount > 0.025;

      const faceW      = abs(lm[454].x - lm[234].x) * width;
      const baseRadius = map(faceW, 60, 280, 55, 200, true);
      const openScale  = map(openAmount, 0.025, 0.10, 0.6, 1.5, true);
      mouthFogRadius   = baseRadius * openScale;

      faceDetected = true;
    } else {
      faceDetected = false;
      mouthOpen    = false;
    }
  });
  async function sendFrame() {
    if (capture && capture.elt.readyState >= 2)
      await faceMesh.send({ image: capture.elt });
    requestAnimationFrame(sendFrame);
  }
  setTimeout(sendFrame, 1200);
}

// ================================================================
// Drip — eraseG에 자국 남기며 화면 끝까지 흘러내림
// ================================================================
class Drip {
  constructor(x, y, delay = 0) {
    this.x      = x + random(-2, 2);
    this.y      = y;
    this.vy     = 0;                            // 처음엔 정지 (막 맺힌 물방울)
    this.maxVy  = random(0.12, 0.45);           // 개별 종단속도 (랜덤)
    this.accel  = random(0.001, 0.004);        // 중력 가속도 (물방울 무게에 따라 랜덤)
    this.w      = random(3, 5);
    this.delay  = delay;
    this.born   = millis();
    this.dead   = false;
    // 40%는 중간에 멈춤, 60%는 화면 끝까지
    this.maxDrop = random() < 0.4
      ? random(30, 120)
      : height + 20;
    this.dropped = 0;
  }

  update() {
    if (millis() - this.born < this.delay) return;
    this.vy      = min(this.vy + this.accel, this.maxVy);
    this.y      += this.vy;
    this.dropped += this.vy;

    eraseG.fill(255);
    eraseG.noStroke();
    eraseG.ellipse(this.x, this.y, this.w * 2, this.w * 2);

    if (this.dropped >= this.maxDrop || this.y > height + 20) this.dead = true;
  }

  render() {}
}
