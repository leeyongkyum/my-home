const test = require("node:test");
const assert = require("node:assert/strict");
const { Detector, frameFeatures } = require("../detector.js");

const SR = 48000;
const FFT = 4096;
const BIN_HZ = SR / FFT;

const QUIET = { levelDb: -60, lowRatio: 0.3, centroidHz: 1500 };
const SNORE = { levelDb: -35, lowRatio: 0.9, centroidHz: 250 };
const SPEECH = { levelDb: -35, lowRatio: 0.4, centroidHz: 1200 };
const HF_NOISE = { levelDb: -35, lowRatio: 0.1, centroidHz: 3000 };

// [특징, 프레임 수] 순서대로 0.1초 간격으로 입력하고 끝난 이벤트 목록을 반환
function run(seq, opts) {
  const det = new Detector(opts);
  const events = [];
  let k = 0;
  for (const [feat, n] of seq) {
    for (let i = 0; i < n; i++, k++) {
      const r = det.process(feat, k * 0.1);
      if (r.closed) events.push(r.closed);
    }
  }
  const last = det.flush();
  if (last) events.push(last);
  return events;
}

function spectrumWithPeak(freqHz, peakDb) {
  const mag = new Float32Array(FFT / 2 + 1).fill(-100);
  mag[Math.round(freqHz / BIN_HZ)] = peakDb;
  return mag;
}

test("frameFeatures: 저주파 피크는 lowRatio≈1, 무게중심≈피크 주파수", () => {
  const f = frameFeatures(spectrumWithPeak(200, -20), SR, FFT);
  assert.ok(f.lowRatio > 0.99, `lowRatio=${f.lowRatio}`);
  assert.ok(Math.abs(f.centroidHz - 200) < 5, `centroid=${f.centroidHz}`);
});

test("frameFeatures: 고주파 피크는 lowRatio≈0", () => {
  const f = frameFeatures(spectrumWithPeak(3000, -20), SR, FFT);
  assert.ok(f.lowRatio < 0.01, `lowRatio=${f.lowRatio}`);
  assert.ok(Math.abs(f.centroidHz - 3000) < 5, `centroid=${f.centroidHz}`);
});

test("frameFeatures: 무음(-Infinity)은 바닥값으로 처리", () => {
  const mag = new Float32Array(FFT / 2 + 1).fill(-Infinity);
  const f = frameFeatures(mag, SR, FFT);
  assert.equal(f.levelDb, -120);
  assert.equal(f.lowRatio, 0);
});

test("2초짜리 코골이 한 번을 정확히 한 이벤트로 기록", () => {
  const events = run([[QUIET, 50], [SNORE, 20], [QUIET, 50]]);
  assert.equal(events.length, 1);
  assert.ok(Math.abs(events[0].durationSec - 2.0) < 0.15, `duration=${events[0].durationSec}`);
  assert.ok(Math.abs(events[0].intensityDb - 25) < 1, `intensity=${events[0].intensityDb}`);
});

test("0.5초짜리 짧은 소리는 무시", () => {
  const events = run([[QUIET, 30], [SNORE, 5], [QUIET, 30]]);
  assert.equal(events.length, 0);
});

test("0.3초 이하 공백은 한 번의 코골이로 병합", () => {
  const events = run([[QUIET, 30], [SNORE, 10], [QUIET, 3], [SNORE, 10], [QUIET, 30]]);
  assert.equal(events.length, 1);
  assert.ok(Math.abs(events[0].durationSec - 2.3) < 0.15, `duration=${events[0].durationSec}`);
});

test("공백이 0.4초를 넘으면 별개의 이벤트로 분리", () => {
  const events = run([[QUIET, 30], [SNORE, 10], [QUIET, 10], [SNORE, 10], [QUIET, 30]]);
  assert.equal(events.length, 2);
});

test("말소리 특성(무게중심 1200Hz)은 코골이로 잡지 않음", () => {
  const events = run([[QUIET, 30], [SPEECH, 30], [QUIET, 30]]);
  assert.equal(events.length, 0);
});

test("고주파 위주의 큰 소리는 코골이로 잡지 않음", () => {
  const events = run([[QUIET, 30], [HF_NOISE, 30], [QUIET, 30]]);
  assert.equal(events.length, 0);
});

test("계속 깔린 일정한 소음(선풍기 등)은 기준선에 흡수되어 무시", () => {
  const FAN = { levelDb: -45, lowRatio: 0.9, centroidHz: 200 };
  const events = run([[FAN, 600]]);
  assert.equal(events.length, 0);
});

test("일정한 소음 위에 더 큰 코골이가 생기면 감지", () => {
  const FAN = { levelDb: -45, lowRatio: 0.9, centroidHz: 200 };
  const LOUD = { levelDb: -30, lowRatio: 0.9, centroidHz: 250 };
  const events = run([[FAN, 300], [LOUD, 20], [FAN, 50]]);
  assert.equal(events.length, 1);
});

test("민감도(marginDb)를 낮추면 작은 코골이도 감지", () => {
  const MILD = { levelDb: -50, lowRatio: 0.9, centroidHz: 250 }; // 플로어 -60 대비 +10dB
  const strict = run([[QUIET, 50], [MILD, 20], [QUIET, 50]], { marginDb: 12 });
  const sensitive = run([[QUIET, 50], [MILD, 20], [QUIET, 50]], { marginDb: 8 });
  assert.equal(strict.length, 0);
  assert.equal(sensitive.length, 1);
});
