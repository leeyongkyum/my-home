/*
 * 코골이 감지 로직
 *  - 브라우저: <script src="detector.js"> 로 로드하면 window.SnoreDetector 로 노출
 *  - Node:     require("./detector.js") 로 가져와 테스트
 *
 * 판단 기준 (프레임 단위, 약 0.1초마다 호출)
 *  1) 소리 크기가 "노이즈 플로어(평소 주변 소음)" 보다 marginDb 이상 큼
 *  2) 에너지의 대부분이 저주파 대역(60~500Hz)에 있음  → 코골이는 저음 위주
 *  3) 스펙트럼 무게중심이 maxCentroidHz 이하          → 말소리·고음 기계음 배제
 *  위 조건을 만족하는 프레임이 minDurationSec 이상 이어지면 "코골이 한 번"으로 기록
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SnoreDetector = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const DEFAULTS = {
    bandLowHz: 60,
    bandHighHz: 500,
    maxCentroidHz: 700,
    minLowRatio: 0.6,
    marginDb: 12,
    minDurationSec: 0.8,
    maxGapSec: 0.4,
    floorAlpha: 0.02,
    frameSec: 0.1,
  };

  const SILENCE_DB = -120;

  /**
   * AnalyserNode.getFloatFrequencyData() 결과(dB 배열)에서 프레임 특징 계산
   */
  function frameFeatures(magDb, sampleRate, fftSize, opts) {
    const o = Object.assign({}, DEFAULTS, opts);
    const binHz = sampleRate / fftSize;
    let total = 0;
    let low = 0;
    let weighted = 0;

    for (let i = 0; i < magDb.length; i++) {
      const f = i * binHz;
      if (f < 20 || f > 8000) continue;
      const p = Math.pow(10, magDb[i] / 10);
      if (!isFinite(p)) continue;
      total += p;
      if (f >= o.bandLowHz && f <= o.bandHighHz) low += p;
      weighted += f * p;
    }

    if (total <= 0) return { levelDb: SILENCE_DB, lowRatio: 0, centroidHz: 0 };
    return {
      levelDb: Math.max(SILENCE_DB, 10 * Math.log10(total)),
      lowRatio: low / total,
      centroidHz: weighted / total,
    };
  }

  class Detector {
    constructor(opts) {
      this.o = Object.assign({}, DEFAULTS, opts);
      this.floorDb = null; // 노이즈 플로어 (평소 주변 소음 수준)
      this.cur = null; // 진행 중인 코골이 구간
      this.events = [];
    }

    setMarginDb(v) {
      this.o.marginDb = v;
    }

    get thresholdDb() {
      return this.floorDb === null ? Infinity : this.floorDb + this.o.marginDb;
    }

    /**
     * @param feat  frameFeatures() 결과
     * @param tSec  경과 시간(초)
     * @returns {{isCandidate, closed, floorDb, thresholdDb}}
     *          closed: 이번 프레임에서 끝난 코골이 이벤트(없으면 null)
     */
    process(feat, tSec) {
      const o = this.o;
      if (this.floorDb === null) this.floorDb = feat.levelDb;

      const threshold = this.thresholdDb;
      const isCandidate =
        feat.levelDb > threshold &&
        feat.lowRatio >= o.minLowRatio &&
        feat.centroidHz > 0 &&
        feat.centroidHz <= o.maxCentroidHz;

      let closed = null;
      if (isCandidate) {
        if (!this.cur) {
          this.cur = { startSec: tSec, endSec: tSec, peakDb: feat.levelDb, floorDb: this.floorDb };
        }
        this.cur.endSec = tSec;
        this.cur.peakDb = Math.max(this.cur.peakDb, feat.levelDb);
      } else if (this.cur && tSec - this.cur.endSec > o.maxGapSec) {
        closed = this._close();
      }

      // 노이즈 플로어 갱신. 코골이 중에는 천천히 갱신해서 기준선이 따라 올라가지 않게 함
      const alpha = isCandidate ? o.floorAlpha * 0.1 : o.floorAlpha;
      this.floorDb += alpha * (feat.levelDb - this.floorDb);

      return {
        isCandidate,
        closed,
        floorDb: this.floorDb,
        thresholdDb: this.thresholdDb,
      };
    }

    /** 녹음 종료 시 진행 중인 구간을 마감 */
    flush() {
      return this.cur ? this._close() : null;
    }

    _close() {
      const c = this.cur;
      this.cur = null;
      const durationSec = c.endSec - c.startSec + this.o.frameSec;
      if (durationSec < this.o.minDurationSec) return null;

      const ev = {
        startSec: c.startSec,
        durationSec: Math.round(durationSec * 100) / 100,
        peakDb: c.peakDb,
        intensityDb: c.peakDb - c.floorDb, // 기준선 대비 세기(dB)
      };
      this.events.push(ev);
      return ev;
    }
  }

  return { DEFAULTS, frameFeatures, Detector };
});
