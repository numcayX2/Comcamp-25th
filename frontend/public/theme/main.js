(function(){
  'use strict';
  var REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var OPEN_AT = '2026-11-16T00:00:00+07:00';
  var MAX = 30;
  var API_BASE = (typeof window !== 'undefined' && window.__CC25_API_BASE_URL__) || 'http://localhost:8000/api';
  var GALLERY_BASE = (typeof window !== 'undefined' && window.__CC25_GALLERY_BASE_URL__) || 'https://comcamp25-gallery.sokulshop5.workers.dev/';
  if (GALLERY_BASE && GALLERY_BASE.slice(-1) !== '/') GALLERY_BASE += '/';
  var LOCAL_GALLERY_BASE = '/assets/gallery/';

  function $(id){ return document.getElementById(id); }
  function pad(n){ return String(n).padStart(2,'0'); }

  // Server-authoritative state (driven by GET /api/settings/public with graceful offline fallback)
  var state = {
    serverTime: new Date().toISOString(),
    serverOffsetMs: 0,
    isOpen: false,
    currentCount: 0,
    maxCapacity: MAX,
    registrationOpenAt: OPEN_AT,
    failed: false,
    loading: true,
    syncedPreOpen: false // last sync said "before opening" → re-fetch once (jittered) at 00:00:00
  };

  function getServerNow(){
    return new Date(Date.now() + (state.serverOffsetMs || 0));
  }

  function computeHeroState(){
    if (state.failed) return 'FAILED';
    if (state.loading) return 'LOADING';
    var now = getServerNow().getTime();
    var openAt = new Date(state.registrationOpenAt || OPEN_AT).getTime();
    if (now < openAt && !state.isOpen) return 'PRE_OPEN';
    var seatsLeft = Math.max(0, state.maxCapacity - state.currentCount);
    if (seatsLeft <= 0) return 'FULL';
    if (!state.isOpen && now >= openAt) {
      // If past openAt and server explicitly marks closed while seats remain, check if manual close or preview fallback
      if (state.explicitClosed) return 'CLOSED';
    }
    if (seatsLeft <= 5) return 'ALMOST_FULL';
    return 'OPEN';
  }

  function applyHeroState(){
    var s = computeHeroState();
    var primary = $('cta-primary');
    var secondary = $('cta-secondary');
    var dateLine = $('hero-date-line');
    var dateText = $('hero-date-text');
    var capVal = $('hero-capacity-val');
    var capNote = $('hero-capacity-note');
    var cdNote = $('hero-countdown-note');
    var sticky = $('sticky-cta');
    var mini = $('sticky-mini');
    var seatsBig = $('bento-seats-num');
    var seatsCaption = $('bento-seats-caption');
    if (!primary || !secondary || !sticky || !mini) return;
    // Nobody can have applied before opening, so the status check has nothing to look up.
    secondary.style.display = (s === 'LOADING' || s === 'PRE_OPEN') ? 'none' : '';

    var maxCap = state.maxCapacity || MAX;
    var seatsLeft = Math.max(0, maxCap - state.currentCount);
    var ctaText = 'เปิดรับสมัคร 16 พ.ย.', ctaHref = '#experience', miniLabel = 'เปิดรับ 16 พ.ย. 69', dateMsg = 'เปิดรับสมัครพร้อมกัน 16 พ.ย. 2569 เวลา 00:00 น.', tone = 'ok', stickyDisabled = true;

    if (seatsBig) seatsBig.innerHTML = maxCap + '<small>ที่นั่ง</small>';

    if (s === 'LOADING' || s === 'PRE_OPEN') {
      ctaText = 'เปิดรับสมัคร 16 พ.ย.';
      ctaHref = '#experience';
      miniLabel = 'เปิดรับ 16 พ.ย. 69';
      dateMsg = 'เปิดรับสมัครพร้อมกัน 16 พ.ย. 2569 เวลา 00:00 น.';
      tone = 'ok';
      stickyDisabled = true;
      sticky.textContent = '16 พ.ย. 69';
      secondary.textContent = 'ตรวจสอบสถานะใบสมัคร →';
      secondary.setAttribute('href', '/status');
      if (capVal) capVal.textContent = 'รับ ' + maxCap + ' คน';
      if (capNote) capNote.textContent = 'ม.4–ม.6 และ ปวช.1–ปวช.3';
    } else if (s === 'FAILED') {
      ctaText = 'ดูรายละเอียดค่าย';
      ctaHref = '#experience';
      miniLabel = 'เชื่อมต่อไม่สำเร็จ';
      dateMsg = 'โหลดสถานะไม่สำเร็จ · กดเพื่อลองใหม่';
      tone = 'danger';
      stickyDisabled = true;
      sticky.textContent = 'ตรวจสอบ';
      secondary.textContent = 'ลองเชื่อมต่อใหม่ →';
      secondary.setAttribute('href', '#retry-status');
      if (capVal) capVal.textContent = 'รับ ' + maxCap + ' คน';
    } else if (s === 'OPEN') {
      ctaText = 'สมัครค่าย';
      ctaHref = '/register';
      miniLabel = 'เหลือ ' + seatsLeft + '/' + maxCap + ' ที่นั่ง';
      dateMsg = 'เปิดรับสมัครแล้ว · คัดเลือกตามลำดับการสมัคร';
      tone = 'ok';
      stickyDisabled = false;
      sticky.textContent = 'สมัครค่าย';
      secondary.textContent = 'ตรวจสอบสถานะใบสมัคร →';
      secondary.setAttribute('href', '/status');
      if (capVal) capVal.textContent = 'เหลือ ' + seatsLeft + ' / ' + maxCap + ' ที่นั่ง';
      if (capNote) capNote.textContent = 'คัดเลือกตามลำดับการสมัคร';
      if (seatsCaption) seatsCaption.textContent = 'ขณะนี้เหลือที่นั่งว่าง ' + seatsLeft + ' จาก ' + maxCap + ' ที่นั่ง คัดเลือกตามลำดับการสมัครและยืนยันสิทธิ์ (First-Come, First-Served)';
    } else if (s === 'ALMOST_FULL') {
      ctaText = 'สมัครค่าย (เหลือ ' + seatsLeft + ' ที่นั่ง)';
      ctaHref = '/register';
      miniLabel = 'เหลือ ' + seatsLeft + ' ที่นั่ง';
      dateMsg = 'ใกล้เต็มแล้ว · เหลือเพียง ' + seatsLeft + ' ที่นั่งสุดท้าย';
      tone = 'amber';
      stickyDisabled = false;
      sticky.textContent = 'สมัคร';
      secondary.textContent = 'ตรวจสอบสถานะใบสมัคร →';
      secondary.setAttribute('href', '/status');
      if (capVal) capVal.textContent = 'เหลือ ' + seatsLeft + ' / ' + maxCap + ' ที่นั่ง';
      if (capNote) capNote.textContent = 'ใกล้เต็มแล้ว';
      if (seatsCaption) seatsCaption.textContent = 'ใกล้เต็มแล้ว! เหลือเพียง ' + seatsLeft + ' ที่นั่งสุดท้าย คัดเลือกแบบ First-Come, First-Served';
    } else if (s === 'FULL') {
      ctaText = 'ลงชื่อสำรองสิทธิ์';
      ctaHref = '/register';
      miniLabel = 'ที่นั่งเต็มแล้ว';
      dateMsg = 'ที่นั่งหลักเต็มแล้ว (' + maxCap + '/' + maxCap + ') · เปิดรับรายชื่อสำรอง';
      tone = 'danger';
      stickyDisabled = false;
      sticky.textContent = 'สำรองสิทธิ์';
      secondary.textContent = 'ตรวจสอบสถานะใบสมัคร →';
      secondary.setAttribute('href', '/status');
      if (capVal) capVal.textContent = 'เต็มแล้ว (' + maxCap + '/' + maxCap + ')';
      if (capNote) capNote.textContent = 'เปิดรับรายชื่อสำรอง';
    } else { // CLOSED
      ctaText = 'ดูรายละเอียดค่าย';
      ctaHref = '#experience';
      miniLabel = 'ปิดรับสมัครแล้ว';
      dateMsg = 'ปิดรับสมัครแล้ว · ตรวจสอบผลได้ทางหน้าตรวจสอบสถานะ';
      tone = 'danger';
      stickyDisabled = true;
      sticky.textContent = 'ปิดแล้ว';
      secondary.textContent = 'ตรวจสอบสถานะใบสมัคร →';
      secondary.setAttribute('href', '/status');
      if (capVal) capVal.textContent = 'ปิดรับสมัครแล้ว';
    }

    var primarySpan = primary.querySelector('span');
    if (primarySpan) {
      primarySpan.textContent = ctaText;
    } else {
      primary.textContent = ctaText;
    }
    primary.setAttribute('href', ctaHref);

    if (dateLine) dateLine.setAttribute('data-tone', tone);
    if (dateText) dateText.textContent = dateMsg;

    var cdLabel = document.querySelector('[data-dock-cd-label]');
    var cdVal = document.querySelector('[data-dock-countdown]');
    if (cdLabel && cdVal) {
      if (s === 'PRE_OPEN' || s === 'LOADING') {
        cdLabel.textContent = 'วันเปิดรับสมัคร';
        cdVal.textContent = '16 พ.ย. 2569';
      } else {
        cdLabel.textContent = 'สถานะการรับสมัคร';
        if (s === 'OPEN') {
          cdVal.textContent = 'เปิดรับสมัครอยู่';
          if (cdNote) cdNote.textContent = 'คัดเลือก First-Come, First-Served';
        } else if (s === 'ALMOST_FULL') {
          cdVal.textContent = 'ใกล้เต็มแล้ว';
          if (cdNote) cdNote.textContent = 'เหลือ ' + seatsLeft + ' ที่นั่งสุดท้าย';
        } else if (s === 'FULL') {
          cdVal.textContent = 'เปิดรับตัวสำรอง';
          if (cdNote) cdNote.textContent = 'ที่นั่งหลักครบ ' + maxCap + ' คนแล้ว';
        } else if (s === 'CLOSED') {
          cdVal.textContent = 'ปิดรับสมัครแล้ว';
          if (cdNote) cdNote.textContent = 'ตรวจสอบสถานะใบสมัครได้ตลอดเวลา';
        }
      }
    }

    mini.textContent = miniLabel;
    sticky.disabled = stickyDisabled;
    sticky.setAttribute('aria-disabled', stickyDisabled ? 'true' : 'false');
    tickCountdown();
  }

  // Midnight Zero Jitter Buffer (AGENTS.md §8): when a pre-open countdown reaches 00:00:00, every
  // open tab would re-fetch /api/settings/public in the same instant (thundering herd). Each tab
  // waits a random 200–2000 ms instead, and schedules at most one such re-fetch per pre-open sync.
  var midnightResyncScheduled = false;

  function tickCountdown(){
    var now = getServerNow().getTime();
    var target = new Date(state.registrationOpenAt || OPEN_AT).getTime();
    var diff = Math.max(0, target - now);
    if (diff === 0 && state.syncedPreOpen && !midnightResyncScheduled) {
      midnightResyncScheduled = true;
      setTimeout(function(){ syncServerStatus(true); }, 200 + Math.floor(Math.random() * 1800));
    }
    var total = Math.floor(diff / 1000);
    var d = Math.min(99, Math.floor(total / 86400));
    var h = Math.floor((total % 86400) / 3600);
    var m = Math.floor((total % 3600) / 60);
    var s = total % 60;
    var cdNote = $('hero-countdown-note');
    var st = computeHeroState();
    if (cdNote && (st === 'PRE_OPEN' || st === 'LOADING')) {
      cdNote.textContent = 'อีก ' + d + ' วัน ' + pad(h) + ':' + pad(m) + ':' + pad(s) + ' ชม.';
    }
  }

  function navigateToRegister(){
    if (computeHeroState() === 'PRE_OPEN' || computeHeroState() === 'CLOSED' || computeHeroState() === 'LOADING') return;
    window.location.href = '/register';
  }

  var stickyBtn = $('sticky-cta');
  var secondaryBtn = $('cta-secondary');
  if (stickyBtn) stickyBtn.addEventListener('click', navigateToRegister);
  if (secondaryBtn) {
    secondaryBtn.addEventListener('click', function(e){
      if (secondaryBtn.getAttribute('href') === '#retry-status') {
        e.preventDefault();
        syncServerStatus();
      }
    });
  }

  // quiet: background refresh (the midnight re-fetch). The hero keeps its current state while the
  // request runs instead of flashing the loading state, and a failure keeps the last good data.
  function syncServerStatus(quiet){
    if (!quiet) {
      state.loading = true;
      state.failed = false;
      applyHeroState();
    }

    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timeoutId = setTimeout(function(){ if (controller) controller.abort(); }, 3000);
    var url = API_BASE.replace(/\/$/, '') + '/settings/public';

    fetch(url, {
      signal: controller ? controller.signal : undefined,
      headers: { 'Accept': 'application/json' }
    })
      .then(function(res){
        clearTimeout(timeoutId);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function(data){
        state.loading = false;
        state.failed = false;
        state.serverTime = data.serverTime || new Date().toISOString();
        var serverEpoch = new Date(state.serverTime).getTime();
        state.serverOffsetMs = isFinite(serverEpoch) ? (serverEpoch - Date.now()) : 0;
        state.registrationOpenAt = data.registrationOpenAt || OPEN_AT;
        state.isOpen = Boolean(data.isOpen);
        state.currentCount = typeof data.currentCount === 'number' ? data.currentCount : 0;
        state.maxCapacity = typeof data.maxCapacity === 'number' && data.maxCapacity > 0 ? data.maxCapacity : MAX;
        // Still before opening by the server's clock: arm the midnight re-fetch for when the
        // (offset-corrected) countdown reaches zero. Re-armed by each sync that says "not yet".
        state.syncedPreOpen = !state.isOpen && isFinite(serverEpoch) && serverEpoch < new Date(state.registrationOpenAt).getTime();
        if (state.syncedPreOpen) midnightResyncScheduled = false;
        tickCountdown();
        applyHeroState();
      })
      .catch(function(){
        clearTimeout(timeoutId);
        // A failed midnight re-fetch keeps the last good server data; no retry, so an overloaded
        // server is not hit again by every tab.
        if (quiet) return;
        // Graceful offline fallback per AGENTS.md §0.2 & §8
        state.loading = false;
        state.failed = false;
        state.serverTime = new Date().toISOString();
        state.serverOffsetMs = 0;
        state.registrationOpenAt = OPEN_AT;
        state.currentCount = 0;
        state.maxCapacity = MAX;
        // Offline before opening: still try the server once (jittered) when the countdown ends.
        state.syncedPreOpen = Date.now() < new Date(OPEN_AT).getTime();
        tickCountdown();
        applyHeroState();
      });
  }

  tickCountdown();
  applyHeroState();
  syncServerStatus();
  setInterval(function(){ tickCountdown(); applyHeroState(); }, 1000);

  // Interactive 3D Hardware Stage in Hero Section (Arduino UNO R3 & ESP8266 NodeMCU with real GLB + procedural fallback)
  (function initHeroStage3D(){
    var canvas = $('heroStageCanvas');
    // If managed by modern hero-3d.js module (#heroStage), skip legacy loader
    if (!canvas || $('heroStage')) return;
    var activeBoard = 'arduino';
    var toggles = document.querySelectorAll('[data-stage-toggle]');
    var tagTLText = $('heroStageTagTLText');
    var tagBRText = $('heroStageTagBRText');

    function setBoardUI(which){
      activeBoard = which;
      for (var i = 0; i < toggles.length; i++) {
        var btn = toggles[i];
        btn.setAttribute('aria-pressed', String(btn.getAttribute('data-stage-toggle') === which));
      }
      if (tagTLText && tagBRText) {
        if (which === 'arduino') {
          tagTLText.innerHTML = '<strong>ATmega328P</strong> · Digital D0–D13 &amp; Analog A0–A5';
          tagBRText.innerHTML = '<strong>Arduino UNO R3</strong> · บอร์ดหลักสำหรับฝึกต่อวงจรและเซนเซอร์';
        } else {
          tagTLText.innerHTML = '<strong>ESP-12E Wi-Fi</strong> · SoftAP 192.168.4.1 &amp; HTTP Server';
          tagBRText.innerHTML = '<strong>ESP8266 NodeMCU</strong> · บอร์ดสร้างหน้าเว็บควบคุมอุปกรณ์ผ่านมือถือ';
        }
      }
      canvas.setAttribute(
        'aria-label',
        'โมเดลสามมิติบอร์ด ' + (which === 'arduino' ? 'Arduino UNO R3' : 'ESP8266 NodeMCU') + ' ลากเมาส์หรือกดลูกศรเพื่อหมุนดูรอบบอร์ดได้'
      );
    }

    for (var i = 0; i < toggles.length; i++) {
      (function(btn){
        btn.addEventListener('click', function(){
          setBoardUI(btn.getAttribute('data-stage-toggle') || 'arduino');
        });
      })(toggles[i]);
    }

    function buildProceduralArduino(THREE){
      var g = new THREE.Group();
      function mat(col, rough, metal){
        return new THREE.MeshStandardMaterial({ color: col, roughness: rough != null ? rough : 0.55, metalness: metal != null ? metal : 0.12 });
      }
      function box(w, h, d, m, x, y, z){
        var mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
        mesh.position.set(x, y, z);
        g.add(mesh);
        return mesh;
      }
      var pcb = mat(0x0e8a92, 0.52, 0.14);
      var dark = mat(0x232629, 0.48, 0.1);
      var silver = mat(0xc9ced4, 0.28, 0.78);
      box(2.76, 0.08, 2.12, pcb, 0, 0, 0);
      box(1.72, 0.12, 0.16, dark, 0.2, 0.09, -0.94);
      box(1.72, 0.12, 0.16, dark, 0.2, 0.09, 0.94);
      box(0.16, 0.12, 1.0, dark, -1.28, 0.09, 0.5);
      box(0.54, 0.16, 0.46, silver, -1.05, 0.11, -0.72);
      var barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.34, 20), dark);
      barrel.rotation.z = Math.PI / 2;
      barrel.position.set(-1.2, 0.11, 0.68);
      g.add(barrel);
      box(0.68, 0.08, 0.32, mat(0x14171a, 0.45), 0.35, 0.08, -0.15);
      box(0.32, 0.06, 0.24, mat(0x111417, 0.4), 0.35, 0.07, 0.35);
      box(0.24, 0.12, 0.1, silver, -0.4, 0.09, 0.0);
      for (var cIdx = 0; cIdx < 4; cIdx++) {
        var cap = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.13, 12), silver);
        cap.position.set(-0.55 + cIdx * 0.3, 0.09, 0.75);
        g.add(cap);
      }
      var led = new THREE.Mesh(
        new THREE.BoxGeometry(0.09, 0.05, 0.06),
        new THREE.MeshStandardMaterial({ color: 0x03B800, emissive: 0x03B800, emissiveIntensity: 1.5 })
      );
      led.position.set(0.95, 0.06, -0.75);
      g.add(led);
      return g;
    }

    function buildProceduralEsp(THREE){
      var g = new THREE.Group();
      function mat(col, rough, metal){
        return new THREE.MeshStandardMaterial({ color: col, roughness: rough != null ? rough : 0.55, metalness: metal != null ? metal : 0.15 });
      }
      function box(w, h, d, m, x, y, z){
        var mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
        mesh.position.set(x, y, z);
        g.add(mesh);
        return mesh;
      }
      var pcb = mat(0x252a30, 0.52, 0.2);
      var dark = mat(0x16191d, 0.48, 0.12);
      var silver = mat(0xc2c8ce, 0.26, 0.82);
      var gold = mat(0xd9a12b, 0.32, 0.75);
      box(2.35, 0.08, 1.32, pcb, 0, 0, 0);
      for (var row = 0; row < 2; row++) {
        for (var col = 0; col < 15; col++) {
          box(0.045, 0.16, 0.045, gold, -0.96 + col * 0.138, 0.08, row === 0 ? -0.54 : 0.54);
        }
      }
      box(1.02, 0.1, 0.82, dark, 0.14, 0.09, 0);
      box(0.92, 0.08, 0.72, silver, 0.14, 0.16, 0);
      box(0.32, 0.11, 0.26, silver, -0.92, 0.1, 0);
      box(0.28, 0.07, 0.22, dark, -0.36, 0.08, 0);
      box(0.28, 0.02, 0.68, gold, 0.86, 0.06, 0);
      var led = new THREE.Mesh(
        new THREE.BoxGeometry(0.08, 0.05, 0.06),
        new THREE.MeshStandardMaterial({ color: 0x03B800, emissive: 0x03B800, emissiveIntensity: 1.5 })
      );
      led.position.set(0.75, 0.06, -0.45);
      g.add(led);
      return g;
    }

    function normalizeGlbScene(THREE, scene, targetSpan){
      var root = scene.clone(true);
      root.traverse(function(obj){
        var nm = (obj.name || '').toLowerCase();
        if (nm.indexOf('backdrop') !== -1 || nm.indexOf('plane') !== -1 || nm.indexOf('floor') !== -1) {
          obj.visible = false;
        }
      });
      var box = new THREE.Box3().setFromObject(root);
      var size = new THREE.Vector3();
      var center = new THREE.Vector3();
      box.getSize(size);
      box.getCenter(center);
      root.position.sub(center);
      var maxDim = Math.max(size.x, size.y, size.z);
      var wrapper = new THREE.Group();
      wrapper.add(root);
      if (maxDim > 0) wrapper.scale.setScalar(targetSpan / maxDim);
      return wrapper;
    }

    async function bootStage(){
      try {
        var testCtx = document.createElement('canvas').getContext('webgl') || document.createElement('canvas').getContext('experimental-webgl');
        if (!testCtx) throw new Error('WebGL unavailable');
        var THREE = await import('https://esm.sh/three@0.170.0');
        var GLTFLoaderMod = await import('https://esm.sh/three@0.170.0/examples/jsm/loaders/GLTFLoader.js');
        var GLTFLoader = GLTFLoaderMod.GLTFLoader;

        var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true });
        renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
        if ('outputColorSpace' in renderer && THREE.SRGBColorSpace) {
          renderer.outputColorSpace = THREE.SRGBColorSpace;
        }

        var scene = new THREE.Scene();
        var camera = new THREE.PerspectiveCamera(36, 1, 0.1, 50);
        camera.position.set(0, 2.25, 4.75);
        camera.lookAt(0, 0, 0);

        scene.add(new THREE.HemisphereLight(0xfff9ee, 0x8a8478, 1.35));
        var keyLight = new THREE.DirectionalLight(0xffffff, 1.85);
        keyLight.position.set(2.8, 4.5, 3.4);
        scene.add(keyLight);
        var rimLight = new THREE.DirectionalLight(0xdbeafe, 0.85);
        rimLight.position.set(-3.2, 2.4, -2.5);
        scene.add(rimLight);

        var arduinoHolder = new THREE.Group();
        var espHolder = new THREE.Group();
        arduinoHolder.add(buildProceduralArduino(THREE));
        espHolder.add(buildProceduralEsp(THREE));

        // Soft contact shadow: a radial-gradient sprite instead of a hard-edged disc
        var shadowTexSize = 256;
        var shadowCanvas = document.createElement('canvas');
        shadowCanvas.width = shadowCanvas.height = shadowTexSize;
        var shadowCtx = shadowCanvas.getContext('2d');
        var shadowGrad = shadowCtx.createRadialGradient(
          shadowTexSize / 2, shadowTexSize / 2, 0,
          shadowTexSize / 2, shadowTexSize / 2, shadowTexSize / 2
        );
        shadowGrad.addColorStop(0, 'rgba(18,19,22,0.20)');
        shadowGrad.addColorStop(0.42, 'rgba(18,19,22,0.09)');
        shadowGrad.addColorStop(0.72, 'rgba(18,19,22,0.03)');
        shadowGrad.addColorStop(1, 'rgba(18,19,22,0)');
        shadowCtx.fillStyle = shadowGrad;
        shadowCtx.fillRect(0, 0, shadowTexSize, shadowTexSize);
        var shadowTexture = new THREE.CanvasTexture(shadowCanvas);
        if ('colorSpace' in shadowTexture && THREE.SRGBColorSpace) {
          shadowTexture.colorSpace = THREE.SRGBColorSpace;
        }

        var shadow = new THREE.Mesh(
          new THREE.CircleGeometry(2.9, 48),
          new THREE.MeshBasicMaterial({ map: shadowTexture, transparent: true, depthWrite: false })
        );
        shadow.rotation.x = -Math.PI / 2;
        shadow.position.y = -0.92;

        scene.add(shadow, arduinoHolder, espHolder);
        espHolder.visible = false;
        espHolder.scale.setScalar(0.01);

        // Stream high-detail GLB models from /models/ and swap seamlessly over procedural meshes
        if (GLTFLoader) {
          var loader = new GLTFLoader();
          loader.load('/models/ArduinoR3.glb', function(gltf){
            if (gltf && gltf.scene) {
              var realUno = normalizeGlbScene(THREE, gltf.scene, 3.05);
              arduinoHolder.clear();
              arduinoHolder.add(realUno);
            }
          }, undefined, function(){ /* keep procedural fallback */ });

          loader.load('/models/esp8266.glb', function(gltf){
            if (gltf && gltf.scene) {
              var realEsp = normalizeGlbScene(THREE, gltf.scene, 2.75);
              espHolder.clear();
              espHolder.add(realEsp);
            }
          }, undefined, function(){ /* keep procedural fallback */ });
        }

        var targetRot = { rx: 0.34, ry: 0.52 };
        var currentRot = { rx: 0.34, ry: 0.52 };
        var lastInteract = 0, running = false, raf = null, t = 0;

        function resize(){
          var parent = canvas.parentElement;
          if (!parent) return;
          var r = parent.getBoundingClientRect();
          if (r.width < 4 || r.height < 4) return;
          renderer.setSize(r.width, r.height, false);
          camera.aspect = r.width / r.height;
          // On narrow viewports pull the camera back along the same viewing axis so
          // the board stays fully framed instead of touching the screen edges.
          var narrow = Math.min(1, r.width / 560);
          var pullBack = narrow < 0.999 ? 1 / Math.max(0.55, narrow) : 1;
          camera.position.set(0, 2.25 * pullBack, 4.75 * pullBack);
          camera.lookAt(0, 0, 0);
          camera.updateProjectionMatrix();
        }
        resize();
        if (typeof ResizeObserver !== 'undefined' && canvas.parentElement) {
          new ResizeObserver(resize).observe(canvas.parentElement);
        } else {
          window.addEventListener('resize', resize);
        }

        var dragging = false, px = 0, py = 0;
        function clampVal(v, lo, hi){ return Math.max(lo, Math.min(hi, v)); }

        canvas.addEventListener('pointerdown', function(e){
          dragging = true;
          px = e.clientX;
          py = e.clientY;
          if (canvas.setPointerCapture) {
            try { canvas.setPointerCapture(e.pointerId); } catch (_err) {}
          }
          lastInteract = t;
        });
        canvas.addEventListener('pointermove', function(e){
          if (!dragging) return;
          targetRot.ry += (e.clientX - px) * 0.0085;
          targetRot.rx = clampVal(targetRot.rx + (e.clientY - py) * 0.0065, -0.45, 0.95);
          px = e.clientX;
          py = e.clientY;
          lastInteract = t;
        });
        canvas.addEventListener('pointerup', function(){ dragging = false; });
        canvas.addEventListener('pointercancel', function(){ dragging = false; });
        canvas.addEventListener('keydown', function(e){
          var step = e.shiftKey ? 0.03 : 0.1;
          if (e.key === 'ArrowLeft') { targetRot.ry -= step; e.preventDefault(); }
          else if (e.key === 'ArrowRight') { targetRot.ry += step; e.preventDefault(); }
          else if (e.key === 'ArrowUp') { targetRot.rx = clampVal(targetRot.rx - step, -0.45, 0.95); e.preventDefault(); }
          else if (e.key === 'ArrowDown') { targetRot.rx = clampVal(targetRot.rx + step, -0.45, 0.95); e.preventDefault(); }
          lastInteract = t;
        });

        function loop(){
          if (!running) { raf = null; return; }
          raf = requestAnimationFrame(loop);
          t += 0.016;
          if (!REDUCED && (t - lastInteract > 2.2)) {
            // Idle turntable: ~one revolution per minute at 60fps.
            targetRot.ry += 0.0018;
          }
          currentRot.rx += (targetRot.rx - currentRot.rx) * 0.11;
          currentRot.ry += (targetRot.ry - currentRot.ry) * 0.14;

          var activeGrp = activeBoard === 'arduino' ? arduinoHolder : espHolder;
          var otherGrp = activeBoard === 'arduino' ? espHolder : arduinoHolder;

          var gs = activeGrp.scale.x + (1 - activeGrp.scale.x) * 0.14;
          activeGrp.scale.setScalar(gs);
          activeGrp.visible = activeGrp.scale.x > 0.02;

          var os = otherGrp.scale.x + (0 - otherGrp.scale.x) * 0.16;
          otherGrp.scale.setScalar(os);
          otherGrp.visible = otherGrp.scale.x > 0.02;

          var bob = REDUCED ? 0 : Math.sin(t * 1.3) * 0.055;
          activeGrp.rotation.x = currentRot.rx;
          activeGrp.rotation.y = currentRot.ry;
          activeGrp.position.y = bob;
          otherGrp.position.y = bob;

          renderer.render(scene, camera);
        }

        function setRunning(on){
          running = on;
          if (running && !raf) loop();
        }

        if ('IntersectionObserver' in window) {
          new IntersectionObserver(function(entries){
            setRunning(entries[0].isIntersecting && !document.hidden);
          }, { rootMargin: '80px' }).observe(canvas);
        } else {
          setRunning(true);
        }
        document.addEventListener('visibilitychange', function(){
          setRunning(!document.hidden);
        });
      } catch (_err) {
        canvas.hidden = true;
        var fb = $('heroStageFallback');
        if (fb) fb.hidden = false;
      }
    }

    bootStage();
  })();

  // GSAP enhance-only motion (content visible at first paint; transform-only, respects reduced motion)
  function initGsap(){
    try {
      if (REDUCED || typeof gsap === 'undefined') return;
      if (typeof ScrollTrigger !== 'undefined') gsap.registerPlugin(ScrollTrigger);
      var ease = 'power2.out';

      if (typeof ScrollTrigger !== 'undefined') {
        (function(){
          var journey = document.querySelector('.journey');
          var jSteps = journey ? gsap.utils.toArray('.journey .step') : [];
          if (!journey || !jSteps.length) return;
          gsap.to(journey, { '--jp': 1, ease: 'none',
            scrollTrigger: { trigger: journey, start: 'top 70%', end: 'bottom 65%', scrub: 0.35 } });
          jSteps.forEach(function(step){
            ScrollTrigger.create({
              trigger: step,
              start: 'top 72%',
              end: 'bottom 42%',
              onEnter: function(){ step.classList.add('is-active'); },
              onEnterBack: function(){ step.classList.add('is-active'); step.classList.remove('is-done'); },
              onLeave: function(){ step.classList.remove('is-active'); step.classList.add('is-done'); },
              onLeaveBack: function(){ step.classList.remove('is-active','is-done'); }
            });
          });
        })();
        initEditorialMotion();
      }
    } catch(e){}
  }


  // Editorial immersive motion (sections 02–06 + footer + hero exit + page progress).
  // Enhance-only: no CSS hides content, everything is created inside matchMedia(no-preference),
  // so reduced-motion users and no-JS users see the final static layout.
  function initEditorialMotion(){
    var mm = gsap.matchMedia();
    mm.add('(prefers-reduced-motion: no-preference)', function(){
      var ease = 'power3.out';
      var desktop = window.matchMedia('(min-width: 900px)').matches;

      // 1) Page progress hairline (mix-blend keeps it visible on the dark gallery)
      var bar = document.createElement('div');
      bar.className = 'ed-progress';
      bar.setAttribute('aria-hidden', 'true');
      document.body.appendChild(bar);
      gsap.set(bar, { scaleX: 0, transformOrigin: '0 50%' });
      gsap.to(bar, { scaleX: 1, ease: 'none',
        scrollTrigger: { trigger: document.documentElement, start: 'top top', end: 'bottom bottom', scrub: 0.2 } });

      // 2) Hero exit: copy lifts, stage drifts and softens as you scroll into 02
      var hero = document.querySelector('.hero');
      if (hero) {
        var heroTl = gsap.timeline({ defaults: { ease: 'none' },
          scrollTrigger: { trigger: hero, start: 'top top', end: 'bottom top', scrub: 0.5 } });
        if (hero.querySelector('.hero__copy')) heroTl.to('.hero__copy', { yPercent: -14, opacity: 0.15 }, 0);
        if (hero.querySelector('.hero__stage-wrap')) heroTl.to('.hero__stage-wrap', { yPercent: desktop ? -7 : -4, scale: 0.94, opacity: 0.35 }, 0);
        if (hero.querySelector('.hero__bar')) heroTl.to('.hero__bar', { opacity: 0 }, 0);
      }

      // 3) Per-section choreography
      gsap.utils.toArray('.ed-sec').forEach(function(sec){
        var idx = sec.querySelector('.ed-index');
        var title = sec.querySelector('.section-title, .exp-title');
        var lead = sec.querySelector('.section-head .body, .exp-lead');
        var tl = gsap.timeline({ defaults: { ease: ease },
          scrollTrigger: { trigger: sec, start: 'top 72%', once: true } });
        if (idx) tl.from(idx, { x: -18, opacity: 0, duration: 0.6 }, 0);
        if (title) tl.from(title, { yPercent: 40, opacity: 0, clipPath: 'inset(0 0 100% 0)', duration: 1.0, clearProps: 'clipPath,transform,opacity' }, 0.08);
        if (lead) tl.from(lead, { y: 18, opacity: 0, duration: 0.8 }, 0.3);

        // Hairline draws left → right (container top rules use --rule-p)
        sec.querySelectorAll('.exp-list, .bento, .journey, .tm-bento, .faq').forEach(function(box){
          gsap.fromTo(box, { '--rule-p': 0 }, { '--rule-p': 1, duration: 1.3, ease: 'expo.out',
            scrollTrigger: { trigger: box, start: 'top 88%', once: true } });
        });
      });

      // 4) Row reveals: batched so rows entering together cascade
      ScrollTrigger.batch('.exp-item, .bento .card, .journey .step, .tm-tile, .faq-item', {
        start: 'top 90%',
        once: true,
        interval: 0.08,
        onEnter: function(els){
          gsap.fromTo(els, { y: 34, opacity: 0 },
            { y: 0, opacity: 1, duration: 0.9, ease: ease, stagger: 0.09, overwrite: 'auto', clearProps: 'transform,opacity' });
        }
      });
      // Hold rows hidden until their batch fires (set after the batch so first paint is never blank)
      gsap.set('.exp-item, .bento .card, .journey .step, .tm-tile, .faq-item', { opacity: 0, y: 34 });
      ScrollTrigger.refresh();

      // 5) Big figures: mask-rise + gentle scrubbed parallax (desktop)
      gsap.utils.toArray('.bento-big, .tm-figure').forEach(function(fig){
        gsap.from(fig, { yPercent: 35, opacity: 0, clipPath: 'inset(0 0 100% 0)', duration: 1.1, ease: 'expo.out', clearProps: 'clipPath,transform,opacity',
          scrollTrigger: { trigger: fig, start: 'top 92%', once: true } });
        if (desktop) {
          gsap.fromTo(fig, { '--py': 24 }, { '--py': -24, ease: 'none',
            scrollTrigger: { trigger: fig, start: 'top bottom', end: 'bottom top', scrub: 0.6 } });
        }
      });

      // 6) Footer colophon
      var foot = document.querySelector('.ed-footer');
      if (foot) {
        gsap.from(foot.querySelectorAll('.ed-index, .footer-title, .footer-meta'), {
          y: 24, opacity: 0, duration: 0.9, ease: ease, stagger: 0.1, clearProps: 'transform,opacity',
          scrollTrigger: { trigger: foot, start: 'top 90%', once: true } });
      }

      if (document.fonts && document.fonts.ready) document.fonts.ready.then(function(){ ScrollTrigger.refresh(); });

      return function(){ if (bar.parentNode) bar.parentNode.removeChild(bar); };
    });
  }

  // Memory Tunnel gallery (scroll-driven 3D photo tunnel), adapted from gallery part re-new.txt.
  (function initMemoryTunnel(){
    "use strict";

    var CONFIG = {
      selector: "#gallery",
      text: {
        intro: {
          eyebrow: "COMCAMP 24 · MEMORIES",
          title: "ภาพรวม\nบรรยากาศปีที่แล้ว",
          subtitle: "ย้อนดูบรรยากาศจากค่ายปีที่แล้ว\nเลื่อนลงเพื่อเดินทางไปด้วยกัน",
        },
        outro: {
          eyebrow: "ComCamp 25",
          titleLines: ["แล้วพบกัน"],
          subtitle: "บทต่อไปของความทรงจำ กำลังรอให้คุณมาเขียนร่วมกัน",
          ctaLabel: "ตรวจสอบสถานะ",
          ctaHref: "/status",
          ctaTarget: "_self",
        },
      },
      images: {
        basePath: GALLERY_BASE,
        usePlaceholder: false,
      },
      scroll: {
        lengthVh: 1400,
        lengthVhMobile: 1100,
        smoothing: 0.12,
      },
      timeline: {
        introFadeStart: 0.02,
        introEnd: 0.12,
        tunnelStart: 0.10,
        tunnelEnd: 0.84,
        outroStart: 0.88,
      },
      motion: {
        groupSize: 3,
        groupGap: 1,
        innerGap: 0.3,
        flightLength: 3.6,
        perspective: 1000,
        zStart: -2600,
        zEnd: 850,
        fadeIn: 0.18,
        fadeOut: 0.1,
        spread: { minR: 0.28, maxR: 0.78 },
        spreadMobile: { minR: 0.2, maxR: 0.6 },
        maxTilt: 6,
        seed: 24,
        preloadAhead: 0.12,
      },
      mobileBreakpoint: 768,
      hooks: { onCtaClick: null },
    };

    var MEMORY_IMAGES = [
      { file: "g01.jpg", alt: "ภาพบรรยากาศค่าย ComCamp #24 ลำดับที่ 1" },
      { file: "g02.jpg", alt: "ภาพบรรยากาศค่าย ComCamp #24 ลำดับที่ 2" },
      { file: "g03.jpg", alt: "ภาพบรรยากาศค่าย ComCamp #24 ลำดับที่ 3" },
      { file: "g04.jpg", alt: "ภาพบรรยากาศค่าย ComCamp #24 ลำดับที่ 4" },
      { file: "g05.jpg", alt: "ภาพบรรยากาศค่าย ComCamp #24 ลำดับที่ 5" },
      { file: "g06.jpg", alt: "ภาพบรรยากาศค่าย ComCamp #24 ลำดับที่ 6" },
      { file: "g07.jpg", alt: "ภาพบรรยากาศค่าย ComCamp #24 ลำดับที่ 7" },
      { file: "g08.jpg", alt: "ภาพบรรยากาศค่าย ComCamp #24 ลำดับที่ 8" },
      { file: "g09.jpg", alt: "ภาพบรรยากาศค่าย ComCamp #24 ลำดับที่ 9" },
      { file: "g10.jpg", alt: "ภาพบรรยากาศค่าย ComCamp #24 ลำดับที่ 10" },
      { file: "g11.jpg", alt: "ภาพบรรยากาศค่าย ComCamp #24 ลำดับที่ 11" },
      { file: "g12.jpg", alt: "ภาพบรรยากาศค่าย ComCamp #24 ลำดับที่ 12" },
      { file: "g13.jpg", alt: "ภาพบรรยากาศค่าย ComCamp #24 ลำดับที่ 13" },
      { file: "g14.jpg", alt: "ภาพบรรยากาศค่าย ComCamp #24 ลำดับที่ 14" },
      { file: "g15.jpg", alt: "ภาพบรรยากาศค่าย ComCamp #24 ลำดับที่ 15" },
      { file: "g16.jpg", alt: "ภาพบรรยากาศค่าย ComCamp #24 ลำดับที่ 16" },
      { file: "g17.jpg", alt: "ภาพบรรยากาศค่าย ComCamp #24 ลำดับที่ 17" },
      { file: "g18.jpg", alt: "ภาพบรรยากาศค่าย ComCamp #24 ลำดับที่ 18" },
      { file: "g19.jpg", alt: "ภาพบรรยากาศค่าย ComCamp #24 ลำดับที่ 19" },
      { file: "g20.jpg", alt: "ภาพบรรยากาศค่าย ComCamp #24 ลำดับที่ 20" },
      { file: "g21.jpg", alt: "ภาพบรรยากาศค่าย ComCamp #24 ลำดับที่ 21" },
      { file: "g22.jpg", alt: "ภาพบรรยากาศค่าย ComCamp #24 ลำดับที่ 22" },
      { file: "g23.jpg", alt: "ภาพบรรยากาศค่าย ComCamp #24 ลำดับที่ 23" },
      { file: "g24.jpg", alt: "ภาพบรรยากาศค่าย ComCamp #24 ลำดับที่ 24" },
      { file: "g25.jpg", alt: "ภาพบรรยากาศค่าย ComCamp #24 ลำดับที่ 25" },
      { file: "g26.jpg", alt: "ภาพบรรยากาศค่าย ComCamp #24 ลำดับที่ 26" },
      { file: "g27.jpg", alt: "ภาพบรรยากาศค่าย ComCamp #24 ลำดับที่ 27" },
      { file: "g28.jpg", alt: "ภาพบรรยากาศค่าย ComCamp #24 ลำดับที่ 28" },
      { file: "g29.jpg", alt: "ภาพบรรยากาศค่าย ComCamp #24 ลำดับที่ 29" },
      { file: "g30.jpg", alt: "ภาพบรรยากาศค่าย ComCamp #24 ลำดับที่ 30" },
      { file: "g31.jpg", alt: "ภาพบรรยากาศค่าย ComCamp #24 ลำดับที่ 31" },
      { file: "g32.jpg", alt: "ภาพบรรยากาศค่าย ComCamp #24 ลำดับที่ 32" },
      { file: "g33.jpg", alt: "ภาพบรรยากาศค่าย ComCamp #24 ลำดับที่ 33" },
      { file: "g34.jpg", alt: "ภาพบรรยากาศค่าย ComCamp #24 ลำดับที่ 34" },
      { file: "g35.jpg", alt: "ภาพบรรยากาศค่าย ComCamp #24 ลำดับที่ 35" },
      { file: "g36.jpg", alt: "ภาพบรรยากาศค่าย ComCamp #24 ลำดับที่ 36" },
      { file: "g37.jpg", alt: "ภาพบรรยากาศค่าย ComCamp #24 ลำดับที่ 37" },
      { file: "g38.jpg", alt: "ภาพบรรยากาศค่าย ComCamp #24 ลำดับที่ 38" },
      { file: "g39.jpg", alt: "ภาพบรรยากาศค่าย ComCamp #24 ลำดับที่ 39" },
      { file: "g40.jpg", alt: "ภาพบรรยากาศค่าย ComCamp #24 ลำดับที่ 40" },
      { file: "g41.jpg", alt: "ภาพบรรยากาศค่าย ComCamp #24 ลำดับที่ 41" },
      { file: "g42.jpg", alt: "ภาพบรรยากาศค่าย ComCamp #24 ลำดับที่ 42" },
      { file: "g43.jpg", alt: "ภาพบรรยากาศค่าย ComCamp #24 ลำดับที่ 43" }
    ];

    var clamp = function(v, min, max){ min = min == null ? 0 : min; max = max == null ? 1 : max; return Math.min(max, Math.max(min, v)); };
    var lerp = function(a, b, t){ return a + (b - a) * t; };
    var progressBetween = function(v, start, end){ return clamp((v - start) / (end - start)); };
    var debounce = function(fn, ms){ var id; return function(){ var a = arguments; clearTimeout(id); id = setTimeout(function(){ fn.apply(null, a); }, ms); }; };

    function createRandom(seed) {
      var s = seed >>> 0;
      return function() {
        s += 0x6d2b79f5;
        var t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    function resolveSrc(data, index, imagesCfg) {
      if (imagesCfg.usePlaceholder) return "https://picsum.photos/seed/comcamp" + (index + 1) + "/800/600";
      return data.src || imagesCfg.basePath + data.file;
    }

    function TunnelRenderer(stageEl, images, imagesCfg) {
      this.stage = stageEl; this.images = images; this.imagesCfg = imagesCfg; this.cards = [];
    }
    TunnelRenderer.prototype.build = function() {
      var frag = document.createDocumentFragment();
      var self = this;
      this.images.forEach(function(data, i) {
        var card = document.createElement("figure");
        card.className = "mt__card";
        var img = document.createElement("img");
        img.alt = data.alt || "";
        img.decoding = "async";
        img.draggable = false;
        img.addEventListener("load", function(){ card.classList.add("is-loaded"); }, { once: true });
        img.addEventListener("error", function(){
          var localFallback = LOCAL_GALLERY_BASE + data.file;
          if (!card._triedLocalFallback && img.getAttribute("src") !== localFallback) {
            card._triedLocalFallback = true;
            img.src = localFallback;
          } else {
            card.style.visibility = "hidden";
          }
        });
        card.appendChild(img);
        frag.insertBefore(card, frag.firstChild);
        self.cards.push({ el: card, img: img, src: resolveSrc(data, i, self.imagesCfg), requested: false, active: false });
      });
      this.stage.appendChild(frag);
    };
    TunnelRenderer.prototype.preload = function(i) {
      var c = this.cards[i];
      if (!c || c.requested) return;
      c.requested = true; c.img.src = c.src;
    };
    TunnelRenderer.prototype.preloadRange = function(from, to) {
      for (var i = from; i < Math.min(to, this.cards.length); i++) this.preload(i);
    };
    TunnelRenderer.prototype.setActive = function(i, on) {
      var c = this.cards[i];
      if (c.active === on) return;
      c.active = on; c.el.classList.toggle("is-active", on);
    };
    TunnelRenderer.prototype.apply = function(i, s) {
      var st = this.cards[i].el.style;
      st.transform = "translate3d(" + s.x.toFixed(1) + "px, " + s.y.toFixed(1) + "px, " + s.z.toFixed(1) + "px) rotate(" + s.rot.toFixed(2) + "deg)";
      st.opacity = s.opacity.toFixed(3);
    };

    function MotionEngine(images, motion) {
      this.m = motion; this.count = images.length;
      this.zEnd = Math.min(motion.zEnd, motion.perspective - 100);
      this.layout(images);
    }
    MotionEngine.prototype.layout = function(images) {
      var m = this.m, rand = createRandom(m.seed), GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
      var rawStarts = images.map(function(_, i){ return Math.floor(i / m.groupSize) * m.groupGap + (i % m.groupSize) * m.innerGap; });
      var total = rawStarts[rawStarts.length - 1] + m.flightLength;
      this.duration = m.flightLength / total;
      this.items = images.map(function(data, i){
        return {
          start: rawStarts[i] / total, angle: i * GOLDEN_ANGLE + rand() * 0.4, radius: rand(),
          tilt: (rand() * 2 - 1) * m.maxTilt,
          fixed: typeof data.x === "number" && typeof data.y === "number", fx: data.x, fy: data.y
        };
      });
    };
    MotionEngine.prototype.resize = function(vw, vh, isMobile) {
      this.halfW = vw / 2; this.halfH = vh / 2; this.spread = isMobile ? this.m.spreadMobile : this.m.spread;
    };
    MotionEngine.prototype.getState = function(i, t, reduced) {
      var it = this.items[i], local = (t - it.start) / this.duration;
      if (local <= 0 || local >= 1) return null;
      var nx, ny;
      if (it.fixed) { nx = it.fx; ny = it.fy; }
      else { var r = lerp(this.spread.minR, this.spread.maxR, it.radius); nx = Math.cos(it.angle) * r; ny = Math.sin(it.angle) * r; }
      var m = this.m;
      return {
        x: nx * this.halfW, y: ny * this.halfH,
        z: reduced ? -300 : lerp(m.zStart, this.zEnd, local),
        rot: it.tilt,
        opacity: Math.min(progressBetween(local, 0, m.fadeIn), 1 - progressBetween(local, 1 - m.fadeOut, 1))
      };
    };
    MotionEngine.prototype.isNear = function(i, t) { return t >= this.items[i].start - this.m.preloadAhead; };

    function SceneText(root, cfg) {
      this.root = root; this.cfg = cfg;
      this.q = function(key){ return root.querySelector('[data-mt="' + key + '"]'); };
      this.intro = this.q("intro"); this.introContent = this.q("intro-content"); this.outro = this.q("outro"); this.cta = this.q("cta");
      this.outroShown = null;
      this.fill(); this.bindCta();
    }
    SceneText.prototype.fill = function() {
      var intro = this.cfg.text.intro, outro = this.cfg.text.outro;
      var set = function(el, value){ if (el && value != null) el.textContent = value; };
      set(this.q("intro-eyebrow"), intro.eyebrow);
      set(this.q("intro-title"), intro.title);
      set(this.q("intro-subtitle"), intro.subtitle);
      set(this.q("outro-eyebrow"), outro.eyebrow);
      set(this.q("outro-subtitle"), outro.subtitle);
      set(this.q("cta-label"), outro.ctaLabel);
      if (this.cta) {
        this.cta.href = outro.ctaHref; this.cta.target = outro.ctaTarget;
        if (outro.ctaTarget === "_blank") this.cta.rel = "noopener";
      }
      var title = this.q("outro-title");
      if (title) {
        title.textContent = "";
        outro.titleLines.forEach(function(line, i){
          if (i > 0) title.appendChild(document.createTextNode(" "));
          var span = document.createElement("span");
          span.className = "mt__outro-line"; span.style.setProperty("--i", i); span.textContent = line;
          title.appendChild(span);
        });
      }
    };
    SceneText.prototype.bindCta = function() {
      if (!this.cta) return;
      var self = this;
      this.cta.addEventListener("click", function(event){
        self.root.dispatchEvent(new CustomEvent("memorytunnel:cta", { bubbles: true, detail: { href: self.cta.href } }));
        var hook = self.cfg.hooks.onCtaClick;
        if (typeof hook === "function") hook(event);
      });
    };
    SceneText.prototype.updateIntro = function(p, tl) {
      var k = progressBetween(p, tl.introFadeStart, tl.introEnd);
      var t = this.root._mtReduced ? 0 : k;
      var s = this.intro.style;
      var c = this.introContent ? this.introContent.style : s;
      // convex-lens bulge while blurring: center scales up then relaxes as it fades
      var bulge = Math.sin(t * Math.PI);
      var scale = 1 + t * 0.7 + bulge * 0.22;
      var blur = t * 26;
      c.transform = "scale(" + scale.toFixed(4) + ")";
      c.filter = blur > 0.01 ? "blur(" + blur.toFixed(2) + "px)" : "none";
      s.opacity = (1 - k).toFixed(3);
      s.transform = "none";
      s.filter = "none";
      s.visibility = k >= 1 ? "hidden" : "visible";
    };
    SceneText.prototype.updateOutro = function(p, tl) {
      var show = p >= tl.outroStart;
      if (show === this.outroShown) return;
      this.outroShown = show;
      this.outro.classList.toggle("is-visible", show);
      this.outro.setAttribute("aria-hidden", String(!show));
      if (this.cta) this.cta.tabIndex = show ? 0 : -1;
    };

    function MemoryTunnel(cfg, images) {
      this.cfg = cfg;
      this.root = document.querySelector(cfg.selector);
      if (!this.root) return;
      this.reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches || REDUCED;
      this.root._mtReduced = this.reduced;
      var stage = this.root.querySelector('[data-mt="stage"]');
      if (!stage) return;
      this.renderer = new TunnelRenderer(stage, images, cfg.images);
      this.engine = new MotionEngine(images, cfg.motion);
      this.text = new SceneText(this.root, cfg);
      this.target = 0; this.current = 0; this.lastTime = 0; this.rafId = null; this.inView = false; this.entered = false;
      var self = this;
      this.tick = function(now){ self._tick(now); };
      this.onScroll = function(){ self.requestTick(); };
      this.onResize = debounce(function(){ self.measure(); self.requestTick(); }, 150);
      this.init();
    }
    MemoryTunnel.prototype.init = function() {
      this.renderer.build();
      this.root.style.setProperty("--mt-perspective", this.cfg.motion.perspective + "px");
      this.measure(); this.observe();
      window.addEventListener("scroll", this.onScroll, { passive: true });
      window.addEventListener("resize", this.onResize);
      this.requestTick();
    };
    MemoryTunnel.prototype.measure = function() {
      var mobile = window.matchMedia("(max-width: " + this.cfg.mobileBreakpoint + "px)").matches;
      var length = mobile ? this.cfg.scroll.lengthVhMobile : this.cfg.scroll.lengthVh;
      this.root.style.setProperty("--mt-length", length + "vh");
      this.engine.resize(window.innerWidth, window.innerHeight, mobile);
    };
    MemoryTunnel.prototype.observe = function() {
      var self = this;
      if (typeof IntersectionObserver === "undefined") { this.inView = true; return; }
      this.io = new IntersectionObserver(function(entries){
        self.inView = entries[entries.length - 1].isIntersecting;
        if (self.inView) { self.renderer.preloadRange(0, self.cfg.motion.groupSize * 2); self.requestTick(); }
      }, { rootMargin: "100% 0px" });
      this.io.observe(this.root);
    };
    MemoryTunnel.prototype.requestTick = function() {
      if (this.rafId === null) this.rafId = requestAnimationFrame(this.tick);
    };
    MemoryTunnel.prototype._tick = function(now) {
      this.rafId = null;
      var rect = this.root.getBoundingClientRect(), vh = window.innerHeight;
      var distance = this.root.offsetHeight - vh;
      this.target = distance > 0 ? clamp(-rect.top / distance) : 0;
      if (!this.entered && rect.top < vh * 0.6) { this.entered = true; this.root.classList.add("is-entered"); }
      var base = this.reduced ? 1 : this.cfg.scroll.smoothing;
      var dt = this.lastTime ? Math.min(64, now - this.lastTime) : 16.667;
      this.lastTime = now;
      var k = !this.inView || base >= 1 ? 1 : 1 - Math.pow(1 - base, dt / 16.667);
      this.current = lerp(this.current, this.target, k);
      if (Math.abs(this.target - this.current) < 0.00005) this.current = this.target;
      this.render(this.current);
      if (this.current !== this.target) this.requestTick(); else this.lastTime = 0;
    };
    MemoryTunnel.prototype.render = function(p) {
      var tl = this.cfg.timeline;
      this.text.updateIntro(p, tl); this.text.updateOutro(p, tl);
      var t = progressBetween(p, tl.tunnelStart, tl.tunnelEnd);
      for (var i = 0; i < this.engine.count; i++) {
        if (this.engine.isNear(i, t)) this.renderer.preload(i);
        var state = this.engine.getState(i, t, this.reduced);
        if (!state) { this.renderer.setActive(i, false); continue; }
        this.renderer.setActive(i, true); this.renderer.apply(i, state);
      }
    };
    MemoryTunnel.prototype.destroy = function() {
      window.removeEventListener("scroll", this.onScroll);
      window.removeEventListener("resize", this.onResize);
      if (this.io) this.io.disconnect();
      if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    };

    window.memoryTunnel = new MemoryTunnel(CONFIG, MEMORY_IMAGES);
  })();

  // Navbar: mobile disclosure + scroll-spy for the section in view.
  (function initNav(){
    var nav = document.querySelector('.site-nav');
    var menu = $('site-menu');
    var toggle = document.querySelector('.nav-toggle');
    var setOpen = function(open){
      if (!toggle || !menu) return;
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      menu.classList.toggle('is-open', open);
    };
    if (menu && toggle && !toggle.dataset.ccNavBound){
      toggle.addEventListener('click', function(){ setOpen(toggle.getAttribute('aria-expanded') !== 'true'); });
      menu.addEventListener('click', function(e){ if (e.target.closest && e.target.closest('a')) setOpen(false); });
      document.addEventListener('keydown', function(e){
        if (e.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true'){ setOpen(false); toggle.focus(); }
      });
      var wide = window.matchMedia('(min-width:768px)');
      var onWide = function(){ if (wide.matches) setOpen(false); };
      if (wide.addEventListener) wide.addEventListener('change', onWide);
      else if (wide.addListener) wide.addListener(onWide);
    }
    if (nav) {
      var gallery = $('gallery');
      if (gallery) {
        var navTick = 0;
        var updateNav = function(){
          navTick = 0;
          var rect = gallery.getBoundingClientRect();
          var navH = nav.offsetHeight || 64;
          // gallery section pushes the navbar up as it enters, and releases it as it leaves
          var push = 0;
          if (rect.top < navH && rect.bottom > 0) {
            // progress of being pushed: 0 at rect.top==navH, 1 at rect.top<=0 (while in view)
            push = Math.min(1, Math.max(0, (navH - rect.top) / navH));
            // if gallery is scrolled past (bottom near top), let nav return
            if (rect.bottom <= navH) push = Math.min(push, Math.max(0, rect.bottom / navH));
          }
          var y = -Math.round(push * (navH + 2));
          nav.style.transform = push > 0 ? 'translateY(' + y + 'px)' : '';
          var hidden = push >= 0.98;
          nav.style.pointerEvents = hidden ? 'none' : '';
          nav.setAttribute('aria-hidden', hidden ? 'true' : 'false');
          if (hidden) setOpen(false);
        };
        var requestNav = function(){ if (!navTick) navTick = requestAnimationFrame(updateNav); };
        window.addEventListener('scroll', requestNav, { passive: true });
        window.addEventListener('resize', requestNav);
        window.addEventListener('load', updateNav);
        updateNav();
      }
      if (menu && 'IntersectionObserver' in window) {
        var links = Array.prototype.slice.call(menu.querySelectorAll('a[href^="#"]'));
        var byId = {}, current = '';
        links.forEach(function(a){
          var el = document.getElementById(a.getAttribute('href').slice(1));
          if (el) byId[el.id] = a;
        });
        var spy = new IntersectionObserver(function(entries){
          entries.forEach(function(entry){
            if (!entry.isIntersecting || entry.target.id === current) return;
            current = entry.target.id;
            links.forEach(function(a){ a.removeAttribute('aria-current'); });
            if (byId[current]) byId[current].setAttribute('aria-current', 'true');
          });
        }, {rootMargin: '-42% 0px -52% 0px'});
        Object.keys(byId).forEach(function(id){ spy.observe(document.getElementById(id)); });
      }
    }
  })();

  if (document.readyState === 'complete') initGsap();
  else window.addEventListener('load', initGsap);
})();
