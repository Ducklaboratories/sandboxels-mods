// realistic_breathing.js - Sandboxels Realism Mod
// Humans breathe O2 -> CO2, hold their breath in thin/no air, panic when low,
// and suffocate (turn to meat) after 20 real seconds without a full breath.
//
// - Removes vanilla's instant "human + oxygen = CO2" reaction
// - Wraps (does not replace) the vanilla body tick, so gravity/walking run at full speed
// - Timing uses its own clock of real, UNPAUSED seconds (works at any TPS, pause-safe)
// - Safe to load more than once: a newer load replaces the older one instead of stacking
//
// Console helpers:  breathTPS()  breathStatus()  breathDebug(true/false)

(function () {
  "use strict";

  // ================= TUNING (all in real seconds) =================
  const CFG = {
    SURVIVAL:  20,    // dies after this long without a full breath
    PANIC:     18,    // panic starts when choke time passes this
    RESERVE:   15,    // below this choke time, humans ration (hold breath) in thin air
    REFILL:    5,     // seconds of air gained per oxygen pixel inhaled
    CALM_MIN:  1.5,   // normal breathing interval
    CALM_MAX:  2,
    GASP_MIN:  0.2,   // gasping interval once air is low
    GASP_MAX:  0.4,
    LOW_AIR:   10,    // start gasping when this little air is left
    MAX_DEPTH: 4,     // max oxygen pixels per breath
    THIN_AIR:  2,     // this many oxygen pixels or fewer counts as "thin"
    PANIC_MOVE: 0.85, // chance per tick to scramble sideways while panicking
    PAUSE_GAP: 1000,  // ms: a gap between ticks longer than this = paused, ignored
  };

  const NEIGHBORS = [
    [-1, -1], [0, -1], [1, -1],
    [-1,  0],          [1,  0],
    [-1,  1], [0,  1], [1,  1],
  ];

  // ================= game clock =================
  // Advances only while ticks are really happening, so pausing freezes everyone's breath.
  let clock = 0;
  let lastTick = -1;
  let lastReal = performance.now();
  let tpsEstimate = 0;
  let debugOn = false;

  function updateClock() {
    if (pixelTicks === lastTick) return;        // already handled this tick
    const real = performance.now();
    const dt = real - lastReal;
    if (lastTick >= 0 && pixelTicks > lastTick && dt > 0 && dt < CFG.PAUSE_GAP) {
      clock += dt / 1000;
      tpsEstimate = tpsEstimate * 0.95 + ((pixelTicks - lastTick) / dt * 1000) * 0.05;
    }
    lastReal = real;
    lastTick = pixelTicks;
  }

  // ================= helpers =================
  function rand(a, b) { return a + Math.random() * (b - a); }

  function pxAt(x, y) {
    return (pixelMap[x] && pixelMap[x][y]) || null;
  }

  function findOxygen(cx, cy) {
    const found = [];
    for (const [dx, dy] of NEIGHBORS) {
      const p = pxAt(cx + dx, cy + dy);
      if (p && !p.del && p.element === "oxygen") found.push(p);
    }
    return found;
  }

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  // ================= install =================
  function install() {
    if (!elements.body) {
      console.error("realistic_breathing: elements.body not found, mod not installed");
      return;
    }

    // 1. Remove vanilla's instant human + oxygen = CO2 reaction
    for (const name of ["body", "head", "human"]) {
      const el = elements[name];
      if (el && el.reactions && el.reactions.oxygen) delete el.reactions.oxygen;
    }

    // 2. Wrap the vanilla body tick (reuse the saved original if we were loaded before)
    const baseTick = elements.body.__breathOrig !== undefined
      ? elements.body.__breathOrig
      : (elements.body.tick || null);
    elements.body.__breathOrig = baseTick;

    elements.body.tick = function (pixel) {
      // Vanilla physics (gravity, walking, eating...) runs every tick, untouched
      if (baseTick) baseTick(pixel);
      if (!pixel || pixel.del || pixel.element !== "body") return;

      updateClock();
      const now = clock;

      // pixel.tmp  = clock time of last full breath
      // pixel.tmp2 = clock time of next breath attempt
      // (tmp/tmp2 are native slots the engine keeps when a pixel moves)
      if (!pixel.tmp) pixel.tmp = now + 0.001;
      if (pixel.tmp > now) pixel.tmp = now;       // loaded save / clock restart: full breath
      if (!pixel.tmp2 || pixel.tmp2 > now + CFG.SURVIVAL) {
        pixel.tmp2 = now + rand(CFG.CALM_MIN, CFG.CALM_MAX);
      }

      const chokeTime = now - pixel.tmp;
      const head = pxAt(pixel.x, pixel.y - 1);
      const hasHead = !!(head && !head.del && head.element === "head");
      const mouth = hasHead ? head : pixel;

      if (debugOn && Math.floor(now) !== pixel._lastLog) {
        pixel._lastLog = Math.floor(now);
        console.log("choke:", chokeTime.toFixed(1) + "s",
          "| oxygen near mouth:", findOxygen(mouth.x, mouth.y).length);
      }

      // ---- Suffocation ----
      if (chokeTime >= CFG.SURVIVAL) {
        if (hasHead) changePixel(head, "meat");
        changePixel(pixel, "meat");
        return;
      }

      // ---- Emergency panic: scramble sideways, head and body move together ----
      if (chokeTime > CFG.PANIC && Math.random() < CFG.PANIC_MOVE) {
        if (!pixel.dir) pixel.dir = Math.random() < 0.5 ? 1 : -1;
        const dir = pixel.dir;
        const bodyFree = isEmpty(pixel.x + dir, pixel.y);
        const headFree = !hasHead || isEmpty(head.x + dir, head.y);
        if (bodyFree && headFree) {
          const hx = hasHead ? head.x : 0, hy = hasHead ? head.y : 0;
          tryMove(pixel, pixel.x + dir, pixel.y);
          if (hasHead) tryMove(head, hx + dir, hy);
        } else {
          pixel.dir = -dir;                       // blocked, turn around
        }
      }

      // ---- Breathing only happens on the timer (no "vacuum cleaner") ----
      if (now < pixel.tmp2) return;

      const airLeft = CFG.SURVIVAL - chokeTime;
      pixel.tmp2 = now + (airLeft < CFG.LOW_AIR
        ? rand(CFG.GASP_MIN, CFG.GASP_MAX)
        : rand(CFG.CALM_MIN, CFG.CALM_MAX));

      const oxygen = findOxygen(mouth.x, mouth.y);

      // No air at all (CO2 cloud / vacuum): hold breath
      if (oxygen.length === 0) return;

      // Rationing: thin air and still has reserves -> hold breath, save the room's air
      if (oxygen.length <= CFG.THIN_AIR && chokeTime < CFG.RESERVE) return;

      // Breathe: random depth, each O2 pixel becomes CO2, stopwatch rolls back
      shuffle(oxygen);
      const depth = Math.min(1 + Math.floor(Math.random() * CFG.MAX_DEPTH), oxygen.length);
      for (let i = 0; i < depth; i++) {
        changePixel(oxygen[i], "carbon_dioxide");
        pixel.tmp += CFG.REFILL;
      }
      if (pixel.tmp > now) pixel.tmp = now;       // can't exceed a full breath
    };

    // ---- Console helpers ----
    window.breathTPS = () => Math.round(tpsEstimate);
    window.breathDebug = (on) => { debugOn = on !== false; return "debug " + (debugOn ? "on" : "off"); };
    window.breathStatus = () => {
      try {
        const list = (typeof currentPixels !== "undefined" ? currentPixels : [])
          .filter(p => p && !p.del && p.element === "body")
          .map(p => ({ x: p.x, y: p.y, chokeSeconds: +(clock - (p.tmp || clock)).toFixed(1) }));
        console.table(list);
        return list.length + " human bodies";
      } catch (e) { return "status failed: " + e.message; }
    };

    console.log("realistic_breathing loaded");
  }

  if (typeof elements !== "undefined" && elements.body) {
    install();
  } else if (typeof runAfterLoad === "function") {
    runAfterLoad(install);
  } else {
    console.error("realistic_breathing: Sandboxels not ready");
  }
})();
