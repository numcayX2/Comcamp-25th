(function(){
  'use strict';
  var REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var OPEN_AT = '2026-11-19T09:00:00+07:00';
  var CLOSE_AT = '2026-12-18T23:59:59+07:00';
  var MAX = 40;
  var API_BASE = (typeof window !== 'undefined' && window.__CC25_API_BASE_URL__) || 'http://localhost:8000/api';
  var GALLERY_BASE = (typeof window !== 'undefined' && window.__CC25_GALLERY_BASE_URL__) || 'https://comcamp25-gallery.sokulshop5.workers.dev/';
  if (GALLERY_BASE && GALLERY_BASE.slice(-1) !== '/') GALLERY_BASE += '/';
  var LOCAL_GALLERY_BASE = '/assets/gallery/';
  var THAI_MONTHS_SHORT = [
    'ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.',
    'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'
  ];

  function $(id){ return document.getElementById(id); }

  function getBangkokDateParts(isoStr){
    var d = new Date(isoStr || OPEN_AT);
    if (!isFinite(d.getTime())) d = new Date(OPEN_AT);
    try {
      if (typeof Intl !== 'undefined' && Intl.DateTimeFormat) {
        var fmt = new Intl.DateTimeFormat('en-US', {
          timeZone: 'Asia/Bangkok',
          year: 'numeric',
          month: 'numeric',
          day: 'numeric',
          hour: 'numeric',
          minute: 'numeric',
          hourCycle: 'h23'
        });
        if (fmt.formatToParts) {
          var parts = fmt.formatToParts(d);
          var map = {};
          for (var i = 0; i < parts.length; i++) {
            map[parts[i].type] = Number(parts[i].value);
          }
          if (map.year && map.month && map.day) {
            var beYear = map.year + 543;
            return {
              day: map.day,
              month: map.month,
              year: map.year,
              beYear: beYear,
              beYear2: ('0' + (beYear % 100)).slice(-2),
              hour: (map.hour || 0) % 24,
              minute: map.minute || 0
            };
          }
        }
      }
    } catch (e) {}
    var bkk = new Date(d.getTime() + 7 * 60 * 60 * 1000);
    var year = bkk.getUTCFullYear();
    var month = bkk.getUTCMonth() + 1;
    var day = bkk.getUTCDate();
    var beYearFallback = year + 543;
    return {
      day: day,
      month: month,
      year: year,
      beYear: beYearFallback,
      beYear2: ('0' + (beYearFallback % 100)).slice(-2),
      hour: bkk.getUTCHours(),
      minute: bkk.getUTCMinutes()
    };
  }

  // Opening time of day in Asia/Bangkok ("09:00"), derived from the same registrationOpenAt as the date.
  function formatOpenTime(isoStr){
    var p = getBangkokDateParts(isoStr);
    return ('0' + p.hour).slice(-2) + ':' + ('0' + p.minute).slice(-2);
  }

  // Sets a label whose template may contain one {t} placeholder. The time goes into a mono span
  // (Thai stays outside it, AGENTS §5.3); the resulting text equals the server-rendered default exactly.
  function setRichLabel(el, tpl, time){
    if (!el) return;
    var i = tpl.indexOf('{t}');
    var plain = tpl.replace('{t}', time);
    if (i < 0) {
      if (el.textContent !== plain || el.children.length) el.textContent = plain;
      return;
    }
    if (el.textContent === plain && el.querySelector('[data-open-time]')) return;
    el.textContent = '';
    el.appendChild(document.createTextNode(tpl.slice(0, i)));
    var m = document.createElement('span');
    m.className = 'font-mono tabular-nums';
    m.setAttribute('data-open-time', '');
    m.textContent = time;
    el.appendChild(m);
    el.appendChild(document.createTextNode(tpl.slice(i + 3)));
  }

  function formatOpenDateNoYear(isoStr){
    var p = getBangkokDateParts(isoStr);
    return p.day + ' ' + THAI_MONTHS_SHORT[p.month - 1];
  }

  function formatOpenDateShort(isoStr){
    var p = getBangkokDateParts(isoStr);
    return p.day + ' ' + THAI_MONTHS_SHORT[p.month - 1] + ' ' + p.beYear2;
  }

  function formatOpenDateFull(isoStr){
    var p = getBangkokDateParts(isoStr);
    return p.day + ' ' + THAI_MONTHS_SHORT[p.month - 1] + ' ' + p.beYear;
  }

  function formatOpenDateDot(isoStr){
    var p = getBangkokDateParts(isoStr);
    return ('0' + p.day).slice(-2) + '.' + ('0' + p.month).slice(-2) + '.' + p.beYear2;
  }

  // Server-authoritative state (driven by GET /api/settings/public with graceful offline fallback)
  var state = {
    serverTime: new Date().toISOString(),
    serverOffsetMs: 0,
    isOpen: false,
    currentCount: 0,
    maxCapacity: MAX,
    campFee: null,
    registrationOpenAt: OPEN_AT,
    registrationCloseAt: CLOSE_AT,
    failed: false,
    loading: true,
    explicitClosed: false,
    syncedPreOpen: false // last sync said "before opening" → re-fetch once (jittered) at open time (09:00:00)
  };

  function formatCampFeeText(raw){
    if (raw === null || raw === undefined || raw === '') return null;
    var n = typeof raw === 'number' ? raw : Number(raw);
    if (!isFinite(n) || n < 0) return null;
    try {
      return n.toLocaleString('th-TH', { maximumFractionDigits: 2 });
    } catch (e) {
      return String(n);
    }
  }

  function getServerNow(){
    return new Date(Date.now() + (state.serverOffsetMs || 0));
  }

  function computeHeroState(){
    if (state.failed) return 'FAILED';
    if (state.loading) return 'LOADING';
    var now = getServerNow().getTime();
    var openAt = new Date(state.registrationOpenAt || OPEN_AT).getTime();
    if (now < openAt && !state.isOpen) return 'PRE_OPEN';
    var closeAt = new Date(state.registrationCloseAt || CLOSE_AT).getTime();
    if (isFinite(closeAt) && now >= closeAt) return 'CLOSED';
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
    var sticky = $('sticky-cta');
    var mini = $('sticky-mini');
    var seatsBig = $('bento-seats-num');
    var seatsCaption = $('bento-seats-caption');
    var extraCtas = document.querySelectorAll('[data-register-cta]');
    var registerHref = (primary && primary.dataset && primary.dataset.registerHref) || '/register';
    // Nobody can have applied before opening, so the status check has nothing to look up.
    if (secondary) secondary.style.display = (s === 'LOADING' || s === 'PRE_OPEN') ? 'none' : '';
    document.documentElement.setAttribute('data-reg-open', (s === 'OPEN' || s === 'ALMOST_FULL') ? 'true' : 'false');

    var maxCap = state.maxCapacity || MAX;
    var seatsLeft = Math.max(0, maxCap - state.currentCount);
    var openAtStr = state.registrationOpenAt || OPEN_AT;
    var openDateNoYear = formatOpenDateNoYear(openAtStr);
    var openDateShort = formatOpenDateShort(openAtStr);
    var openDateFull = formatOpenDateFull(openAtStr);
    var openDateDot = formatOpenDateDot(openAtStr);
    var openTime = formatOpenTime(openAtStr);
    // Pre-open labels always carry the opening time (the site opens at 09:00, not midnight). {t} = mono time span.
    var preOpenWide = 'ลงทะเบียนวันที่ ' + openDateShort + ' ({t} น.)';
    var preOpenSticky = openDateNoYear + ' {t} น.';
    var ctaText = preOpenWide, ctaHref = '#essentials', miniLabel = 'ลงทะเบียนวันที่ ' + openDateShort + ' เวลา ' + openTime + ' น.', stickyText = preOpenSticky, stickyDisabled = true;
    var regCtaText = preOpenWide, regCtaHref = registerHref, regCtaMuted = true;
    var mtLabel = preOpenWide + ' · ดูข้อมูล', mtHref = '#timeline';

    if (seatsBig) {
      seatsBig.innerHTML = maxCap + '<small>ที่นั่ง</small>';
      var seatsCard = seatsBig.closest ? seatsBig.closest('.bento-feature') : null;
      if (seatsCard) seatsCard.setAttribute('data-reg-state', s);
    }

    var feeText = formatCampFeeText(state.campFee);
    if (feeText !== null) {
      document.querySelectorAll('[data-camp-fee-num]').forEach(function(el){
        el.textContent = feeText;
      });
    }

    document.querySelectorAll('[data-open-date-short]').forEach(function(el){
      if (el.textContent !== openDateShort) el.textContent = openDateShort;
    });
    document.querySelectorAll('[data-open-date-full]').forEach(function(el){
      if (el.textContent !== openDateFull) el.textContent = openDateFull;
    });
    document.querySelectorAll('[data-open-date-dot]').forEach(function(el){
      if (el.textContent !== openDateDot) el.textContent = openDateDot;
    });
    document.querySelectorAll('[data-open-time]').forEach(function(el){
      if (el.textContent !== openTime) el.textContent = openTime;
    });
    var maxCapStr = String(maxCap);
    document.querySelectorAll('[data-max-capacity]').forEach(function(el){
      if (el.textContent !== maxCapStr) el.textContent = maxCapStr;
    });

    if (s === 'LOADING' || s === 'PRE_OPEN') {
      ctaText = preOpenWide;
      ctaHref = '#essentials';
      regCtaText = preOpenWide;
      regCtaHref = registerHref;
      regCtaMuted = true;
      mtLabel = preOpenWide + ' · ดูข้อมูล';
      mtHref = '#timeline';
      miniLabel = 'ลงทะเบียนวันที่ ' + openDateShort + ' เวลา ' + openTime + ' น.';
      stickyText = preOpenSticky;
      stickyDisabled = true;
      if (secondary) {
        secondary.textContent = 'ตรวจสอบสถานะใบสมัคร →';
        secondary.setAttribute('href', '/status');
      }
      if (seatsCaption) seatsCaption.textContent = 'จำนวนจำกัด คัดเลือกตามลำดับการสมัครและยืนยันสิทธิ์แบบใครสมัครก่อนได้สิทธิ์ก่อน';
    } else if (s === 'FAILED') {
      ctaText = 'ดูรายละเอียดค่าย';
      ctaHref = '#experience';
      regCtaText = 'ดูรายละเอียดค่าย';
      regCtaHref = '#experience';
      regCtaMuted = true;
      mtLabel = 'ดูรายละเอียดค่าย';
      mtHref = '#experience';
      miniLabel = 'เชื่อมต่อไม่สำเร็จ';
      stickyDisabled = true;
      // Fail closed like the nav drawer/desktop: before opening nobody has an application to check,
      // so keep the pre-open date/time label instead of a dead "ตรวจสอบ" pill.
      stickyText = (Date.now() < new Date(state.registrationOpenAt || OPEN_AT).getTime()) ? preOpenSticky : 'ตรวจสอบ';
      if (secondary) {
        secondary.textContent = 'ลองเชื่อมต่อใหม่ →';
        secondary.setAttribute('href', '#retry-status');
      }
      if (seatsCaption) seatsCaption.textContent = 'จำนวนจำกัด คัดเลือกตามลำดับการสมัครและยืนยันสิทธิ์แบบใครสมัครก่อนได้สิทธิ์ก่อน';
    } else if (s === 'OPEN') {
      ctaText = 'สมัครค่าย';
      ctaHref = registerHref;
      regCtaText = 'สมัครค่าย';
      regCtaHref = registerHref;
      regCtaMuted = false;
      mtLabel = 'สมัครค่าย ComCamp #25';
      mtHref = registerHref;
      miniLabel = 'เหลือ ' + seatsLeft + '/' + maxCap + ' ที่นั่ง';
      stickyDisabled = false;
      stickyText = 'สมัครค่าย';
      if (secondary) {
        secondary.textContent = 'ตรวจสอบสถานะใบสมัคร →';
        secondary.setAttribute('href', '/status');
      }
      if (seatsCaption) seatsCaption.textContent = 'ขณะนี้เหลือที่นั่งว่าง ' + seatsLeft + ' จาก ' + maxCap + ' ที่นั่ง คัดเลือกตามลำดับการสมัครและยืนยันสิทธิ์';
    } else if (s === 'ALMOST_FULL') {
      ctaText = 'สมัครค่าย (เหลือ ' + seatsLeft + ' ที่นั่ง)';
      ctaHref = registerHref;
      regCtaText = 'สมัครค่าย (เหลือ ' + seatsLeft + ')';
      regCtaHref = registerHref;
      regCtaMuted = false;
      mtLabel = 'สมัครค่าย (เหลือ ' + seatsLeft + ' ที่นั่ง)';
      mtHref = registerHref;
      miniLabel = 'เหลือ ' + seatsLeft + ' ที่นั่ง';
      stickyDisabled = false;
      stickyText = 'สมัคร';
      if (secondary) {
        secondary.textContent = 'ตรวจสอบสถานะใบสมัคร →';
        secondary.setAttribute('href', '/status');
      }
      if (seatsCaption) seatsCaption.textContent = 'ใกล้เต็มแล้ว! เหลือเพียง ' + seatsLeft + ' ที่นั่งสุดท้าย คัดเลือกแบบใครสมัครก่อนได้สิทธิ์ก่อน';
    } else if (s === 'FULL') {
      // /register is locked once the camp is full, so the CTA leads to the status page instead.
      ctaText = 'ที่นั่งเต็มแล้ว · ตรวจสอบสถานะ';
      ctaHref = '/status';
      regCtaText = 'ที่นั่งเต็มแล้ว · ตรวจสอบสถานะ';
      regCtaHref = '/status';
      regCtaMuted = true;
      mtLabel = 'ที่นั่งเต็มแล้ว · ตรวจสอบสถานะ';
      mtHref = '/status';
      miniLabel = 'ที่นั่งเต็มแล้ว';
      stickyDisabled = false;
      stickyText = 'ตรวจสถานะ';
      // The primary CTA already leads to /status, so the secondary link points at the camp details.
      if (secondary) {
        secondary.textContent = 'ดูรายละเอียดค่าย →';
        secondary.setAttribute('href', '#experience');
      }
      if (seatsCaption) seatsCaption.textContent = 'ขณะนี้มีผู้สมัครครบ ' + maxCap + ' ที่นั่งแล้ว หากมีผู้สละสิทธิ์ระบบจะคืนที่นั่งว่างให้สมัครได้ทันที';
    } else { // CLOSED
      ctaText = 'ปิดรับสมัครแล้ว · ตรวจสอบสถานะ';
      ctaHref = '/status';
      regCtaText = 'ปิดรับสมัครแล้ว · ตรวจสอบสถานะ';
      regCtaHref = '/status';
      regCtaMuted = true;
      mtLabel = 'ปิดรับสมัครแล้ว · ตรวจสอบสถานะ';
      mtHref = '/status';
      miniLabel = 'ปิดรับสมัครแล้ว';
      stickyDisabled = true;
      stickyText = 'ปิดแล้ว';
      if (secondary) {
        secondary.textContent = 'ดูรายละเอียดค่าย →';
        secondary.setAttribute('href', '#experience');
      }
      if (seatsCaption) seatsCaption.textContent = 'ปิดรับสมัครแล้ว สามารถตรวจสอบสถานะใบสมัครได้ตลอดเวลา';
    }

    if (primary) {
      var primarySpan = primary.querySelector('span');
      setRichLabel(primarySpan || primary, ctaText, openTime);
      primary.setAttribute('href', ctaHref);
    }

    if (extraCtas.length) {
      extraCtas.forEach(function(el){
        var target = el.querySelector('[data-register-cta-label]') || el.querySelector('span');
        setRichLabel(target || el, regCtaText, openTime);
        el.setAttribute('href', regCtaHref);
        el.setAttribute('data-reg-state', s);
        el.classList.toggle('is-pre-open', regCtaMuted);
      });
    }

    var mtCta = document.querySelector('[data-mt="cta"]');
    var mtCtaLabel = document.querySelector('[data-mt="cta-label"]');
    if (mtCta) mtCta.setAttribute('href', mtHref);
    if (mtCtaLabel) setRichLabel(mtCtaLabel, mtLabel, openTime);

    if (mini) mini.textContent = miniLabel;
    if (sticky) {
      setRichLabel(sticky.querySelector('[data-sticky-label]') || sticky, stickyText, openTime);
      sticky.disabled = stickyDisabled;
      sticky.setAttribute('aria-disabled', stickyDisabled ? 'true' : 'false');
    }
    checkMidnightResync();
  }

  // Midnight Zero Jitter Buffer (AGENTS.md §8): when a pre-open countdown reaches the open time (09:00:00), every
  // open tab would re-fetch /api/settings/public in the same instant (thundering herd). Each tab
  // waits a random 200–2000 ms instead, and schedules at most one such re-fetch per pre-open sync.
  var midnightResyncScheduled = false;

  function checkMidnightResync(){
    var now = getServerNow().getTime();
    var target = new Date(state.registrationOpenAt || OPEN_AT).getTime();
    if (now >= target && state.syncedPreOpen && !midnightResyncScheduled) {
      midnightResyncScheduled = true;
      setTimeout(function(){ syncServerStatus(true, true); }, 200 + Math.floor(Math.random() * 1800));
    }
  }

  function navigateToRegister(){
    var s = computeHeroState();
    if (s === 'PRE_OPEN' || s === 'CLOSED' || s === 'LOADING' || s === 'FAILED') return;
    // Full: the form is locked, so the mobile button goes to the status page like the hero CTA.
    window.location.href = s === 'FULL' ? '/status' : '/register';
  }

  var stickyBtn = $('sticky-cta');
  var secondaryBtn = $('cta-secondary');
  if (stickyBtn) stickyBtn.addEventListener('click', navigateToRegister);
  if (secondaryBtn) {
    secondaryBtn.addEventListener('click', function(e){
      if (secondaryBtn.getAttribute('href') === '#retry-status') {
        e.preventDefault();
        syncServerStatus(false, true);
      }
    });
  }

  // Shares the initial page-load /settings/public request with SiteNav.astro via one window slot
  // (see frontend/src/lib/public-settings-cache.ts). Midnight resyncs and manual retries pass
  // forceFresh = true to bypass the slot.
  function fetchPublicSettingsShared(url, forceFresh){
    var slot = typeof window !== 'undefined' ? window.__CC25_PUBLIC_SETTINGS_SLOT__ : null;
    if (!forceFresh && slot && slot.url === url) {
      if (slot.settledAt === 0 || Date.now() - slot.settledAt < 1500) {
        return slot.promise;
      }
    }

    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timeoutId = setTimeout(function(){ if (controller) controller.abort(); }, 3000);
    var nextSlot = { url: url, settledAt: 0, promise: null };

    nextSlot.promise = fetch(url, {
      signal: controller ? controller.signal : undefined,
      headers: { 'Accept': 'application/json' }
    })
      .then(function(res){
        clearTimeout(timeoutId);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function(data){
        nextSlot.settledAt = Date.now();
        return data;
      })
      .catch(function(err){
        clearTimeout(timeoutId);
        if (typeof window !== 'undefined' && window.__CC25_PUBLIC_SETTINGS_SLOT__ === nextSlot) {
          delete window.__CC25_PUBLIC_SETTINGS_SLOT__;
        }
        throw err;
      });

    if (typeof window !== 'undefined') window.__CC25_PUBLIC_SETTINGS_SLOT__ = nextSlot;
    return nextSlot.promise;
  }

  // quiet: background refresh (the midnight re-fetch). The hero keeps its current state while the
  // request runs instead of flashing the loading state, and a failure keeps the last good data.
  function syncServerStatus(quiet, forceFresh){
    if (!quiet) {
      state.loading = true;
      state.failed = false;
      applyHeroState();
    }

    var url = API_BASE.replace(/\/$/, '') + '/settings/public';
    fetchPublicSettingsShared(url, Boolean(forceFresh !== undefined ? forceFresh : quiet))
      .then(function(data){
        state.loading = false;
        state.failed = false;
        state.serverTime = data.serverTime || new Date().toISOString();
        var serverEpoch = new Date(state.serverTime).getTime();
        state.serverOffsetMs = isFinite(serverEpoch) ? (serverEpoch - Date.now()) : 0;
        state.registrationOpenAt = data.registrationOpenAt || OPEN_AT;
        state.registrationCloseAt = data.registrationCloseAt || CLOSE_AT;
        state.isOpen = Boolean(data.isOpen);
        state.explicitClosed = data.isOpen === false;
        state.currentCount = typeof data.currentCount === 'number' ? data.currentCount : 0;
        state.maxCapacity = typeof data.maxCapacity === 'number' && data.maxCapacity > 0 ? data.maxCapacity : MAX;
        state.campFee = (data.campFee !== undefined && data.campFee !== null) ? data.campFee : null;
        // Still before opening by the server's clock: arm the midnight re-fetch for when the
        // (offset-corrected) countdown reaches zero. Re-armed by each sync that says "not yet".
        state.syncedPreOpen = !state.isOpen && isFinite(serverEpoch) && serverEpoch < new Date(state.registrationOpenAt).getTime();
        if (state.syncedPreOpen) midnightResyncScheduled = false;
        checkMidnightResync();
        applyHeroState();
      })
      .catch(function(){
        // A failed midnight re-fetch keeps the last good server data; no retry, so an overloaded
        // server is not hit again by every tab.
        if (quiet) return;
        // Fail closed on /settings/public failure so registration never defaults to OPEN offline.
        state.loading = false;
        state.failed = true;
        state.isOpen = false;
        state.explicitClosed = true;
        state.serverTime = new Date().toISOString();
        state.serverOffsetMs = 0;
        state.registrationOpenAt = OPEN_AT;
        state.registrationCloseAt = CLOSE_AT;
        state.currentCount = 0;
        state.maxCapacity = MAX;
        // Offline before opening: still try the server once (jittered) when the countdown ends.
        state.syncedPreOpen = Date.now() < new Date(OPEN_AT).getTime();
        checkMidnightResync();
        applyHeroState();
      });
  }

  checkMidnightResync();
  applyHeroState();
  syncServerStatus();
  setInterval(function(){ checkMidnightResync(); applyHeroState(); }, 1000);

  // Hero 3D stage is rendered by src/scripts/hero-3d.js (bundled three.js, fallback handled via .hero-stage[data-state="fallback"]).

  // GSAP enhance-only motion (content visible at first paint; transform-only, respects reduced motion)
  function initGsap(){
    try {
      if (REDUCED || typeof gsap === 'undefined') return;
      if (typeof ScrollTrigger !== 'undefined') {
        gsap.registerPlugin(ScrollTrigger);
        initEditorialMotion();
      }
    } catch(e){}
  }


  // Editorial immersive motion (sections 02–05 + CTA + footer + hero exit + page progress).
  // Enhance-only: no CSS hides content, everything is created inside matchMedia(no-preference),
  // so reduced-motion users and no-JS users see the final static layout.
  function initEditorialMotion(){
    var mm = gsap.matchMedia();
    mm.add('(prefers-reduced-motion: no-preference)', function(){
      var ease = 'power3.out';
      var isDesktop = function(){ return window.matchMedia('(min-width: 900px)').matches; };
      var revealTimelines = [];

      // 1) Page progress hairline (mix-blend keeps it visible on the dark gallery)
      var bar = document.createElement('div');
      bar.className = 'ed-progress';
      bar.setAttribute('aria-hidden', 'true');
      document.body.appendChild(bar);
      gsap.set(bar, { scaleX: 0, transformOrigin: '0 50%' });
      gsap.to(bar, { scaleX: 1, ease: 'none',
        scrollTrigger: { trigger: document.documentElement, start: 'top top', end: 'bottom bottom', scrub: 0.2 } });

      // 2) Hero exit: copy lifts, stage drifts and softens as you scroll into 02 (curriculum)
      var hero = document.querySelector('.hero');
      if (hero) {
        var heroTl = gsap.timeline({ defaults: { ease: 'none' },
          scrollTrigger: { trigger: hero, start: 'top top', end: 'bottom top', scrub: 0.5, invalidateOnRefresh: true } });
        if (hero.querySelector('.hero__copy')) heroTl.to('.hero__copy', { yPercent: -14, opacity: 0.15 }, 0);
        if (hero.querySelector('.hero__stage-wrap')) heroTl.to('.hero__stage-wrap', { yPercent: function(){ return isDesktop() ? -7 : -4; }, scale: 0.94, opacity: 0.35 }, 0);
        if (hero.querySelector('.hero__bar')) heroTl.to('.hero__bar', { opacity: 0 }, 0);
      }

      // 3) Per-section choreography
      gsap.utils.toArray('.ed-sec').forEach(function(sec){
        var idx = sec.querySelector('.ed-index');
        var title = sec.querySelector('.section-title');
        var lead = sec.querySelector('.section-head .body');
        var tl = gsap.timeline({ defaults: { ease: ease },
          scrollTrigger: { trigger: sec, start: 'top 92%', once: true, fastScrollEnd: true } });
        if (idx) tl.from(idx, { x: -16, opacity: 0, duration: 0.42, clearProps: 'transform,opacity' }, 0);
        if (title) tl.from(title, { yPercent: 28, opacity: 0, clipPath: 'inset(0 0 100% 0)', duration: 0.62, clearProps: 'clipPath,transform,opacity' }, 0.04);
        if (lead) tl.from(lead, { y: 12, opacity: 0, duration: 0.45, clearProps: 'transform,opacity' }, 0.12);
        revealTimelines.push({ el: sec, tl: tl });

        // Line draws (CSS defaults --rule-p: 1): curriculum spine top → bottom, registration track along its axis
        sec.querySelectorAll('.journey, .tm-bento--steps').forEach(function(box){
          gsap.fromTo(box, { '--rule-p': 0 }, { '--rule-p': 1, duration: 0.95, ease: 'expo.out',
            scrollTrigger: { trigger: box, start: 'top 94%', once: true, fastScrollEnd: true } });
        });

        // Curriculum spine (#experience, formerly #journey): scrubbed numeral parallax, staged reveal, and contiguous active step spy
        if (sec.querySelector('.journey')) {
          var jSteps = gsap.utils.toArray('.journey .step', sec);
          var setActiveStep = function(activeIdx){
            jSteps.forEach(function(s, i){
              s.classList.toggle('is-active', i === activeIdx);
              s.classList.toggle('is-done', activeIdx >= 0 && i < activeIdx);
            });
          };
          jSteps.forEach(function(step, idx){
            var bigNum = step.querySelector('.step-big-num');
            var tag = step.querySelector('.step-num');
            var title = step.querySelector('h3');
            var day = step.querySelector('.day');
            var body = step.querySelector('p');

            if (bigNum) {
              gsap.fromTo(bigNum,
                { y: function(){ return isDesktop() ? 18 : 10; } },
                { y: function(){ return isDesktop() ? -18 : -10; }, ease: 'none',
                  scrollTrigger: { trigger: step, start: 'top bottom', end: 'bottom top', scrub: 0.25, invalidateOnRefresh: true } });
            }

            var stepTl = gsap.timeline({
              scrollTrigger: { trigger: step, start: 'top 96%', once: true, fastScrollEnd: true }
            });
            if (bigNum) stepTl.from(bigNum, { opacity: 0, duration: 0.36, ease: 'power2.out', clearProps: 'opacity' }, 0);
            if (tag) stepTl.from(tag, { x: -12, opacity: 0, duration: 0.36, ease: 'power2.out', clearProps: 'transform,opacity' }, 0);
            if (title) stepTl.from(title, { yPercent: 26, opacity: 0, clipPath: 'inset(0 0 100% 0)', duration: 0.45, ease: ease, clearProps: 'clipPath,transform,opacity' }, 0.04);
            var follow = [day, body].filter(Boolean);
            if (follow.length) stepTl.from(follow, { y: 12, opacity: 0, duration: 0.42, stagger: 0.04, ease: 'power2.out', clearProps: 'transform,opacity' }, 0.09);
            revealTimelines.push({ el: step, tl: stepTl });

            ScrollTrigger.create({
              trigger: step,
              start: 'top 60%',
              end: 'bottom 60%',
              onEnter: function(){ setActiveStep(idx); },
              onEnterBack: function(){ setActiveStep(idx); },
              onLeave: function(){ if (idx === jSteps.length - 1) setActiveStep(jSteps.length); },
              onLeaveBack: function(){ if (idx === 0) setActiveStep(-1); }
            });
          });
        }
      });

      // 4) Row reveals: batched so rows entering together cascade (curriculum steps use the spine choreography above)
      var rowEls = gsap.utils.toArray('.bento .card, .tm-tile, .faq-item');
      var revealRows = function(els){
        var pending = els.filter(function(el){ return el.dataset.ccRevealed !== '1'; });
        if (!pending.length) return;
        pending.forEach(function(el){ el.dataset.ccRevealed = '1'; });
        gsap.to(pending, {
          y: 0,
          opacity: 1,
          duration: 0.42,
          ease: ease,
          stagger: { amount: 0.12 },
          overwrite: 'auto',
          clearProps: 'opacity,transform'
        });
      };

      var initialVh = window.innerHeight || document.documentElement.clientHeight;
      var pendingBatchEls = rowEls.filter(function(el){
        if (el.getBoundingClientRect().top < initialVh) {
          el.dataset.ccRevealed = '1';
          return false;
        }
        return true;
      });
      if (pendingBatchEls.length) {
        gsap.set(pendingBatchEls, { opacity: 0, y: 12 });
        ScrollTrigger.batch(pendingBatchEls, {
          start: 'top bottom',
          once: true,
          interval: 0.03,
          onEnter: function(els){ revealRows(els); }
        });
      }

      // 5) Big figures: mask-rise reveal (scrubbed parallax is desktop-only in separate matchMedia below)
      gsap.utils.toArray('.bento-big, .tm-figure').forEach(function(fig){
        var figTl = gsap.timeline({
          scrollTrigger: { trigger: fig, start: 'top 96%', once: true, fastScrollEnd: true }
        });
        figTl.from(fig, { yPercent: 18, opacity: 0, clipPath: 'inset(0 0 100% 0)', duration: 0.65, ease: 'expo.out', clearProps: 'clipPath,transform,opacity' });
        revealTimelines.push({ el: fig, tl: figTl });
      });

      // 5b) Closing CTA band top hairline draw
      var ctaBand = document.querySelector('.ed-cta-band');
      if (ctaBand) {
        gsap.fromTo(ctaBand, { '--rule-p': 0 }, { '--rule-p': 1, duration: 0.95, ease: 'expo.out',
          scrollTrigger: { trigger: ctaBand, start: 'top 94%', once: true, fastScrollEnd: true } });
      }

      // 6) Footer colophon
      var foot = document.querySelector('.ed-footer');
      if (foot) {
        var footTargets = foot.querySelectorAll('.ed-index, .footer-title, .footer-meta');
        if (footTargets.length) {
          var footTl = gsap.timeline({
            scrollTrigger: { trigger: foot, start: 'top 96%', once: true, fastScrollEnd: true }
          });
          footTl.from(footTargets, { y: 16, opacity: 0, duration: 0.5, ease: ease, stagger: 0.06, clearProps: 'transform,opacity' });
          revealTimelines.push({ el: foot, tl: footTl });
        }
      }

      // Safety check so rows/steps near the bottom of the viewport or scrolled past never stay dimmed
      var ensureVisibleRevealed = function(){
        var vh = window.innerHeight || document.documentElement.clientHeight;
        var docH = document.documentElement.scrollHeight;
        var nearBottom = (window.scrollY + vh) >= (docH - 80);
        var missedRows = [];
        rowEls.forEach(function(el){
          if (el.dataset.ccRevealed === '1') return;
          var rect = el.getBoundingClientRect();
          if (rect.bottom <= 0) {
            el.dataset.ccRevealed = '1';
            gsap.set(el, { clearProps: 'opacity,transform' });
          } else if (rect.top < vh + 12 || (nearBottom && rect.top <= vh + 24)) {
            missedRows.push(el);
          }
        });
        if (missedRows.length) revealRows(missedRows);

        revealTimelines.forEach(function(item){
          if (item.tl.progress() >= 1) return;
          var rect = item.el.getBoundingClientRect();
          if (rect.bottom <= 0) {
            item.tl.progress(1);
          } else if ((rect.top < vh || (nearBottom && rect.top <= vh + 24)) && item.tl.progress() === 0) {
            item.tl.play();
          }
        });
      };

      var settleTimer = 0;
      var onScrollSafety = function(){
        var vh = window.innerHeight || document.documentElement.clientHeight;
        if ((window.scrollY + vh) >= (document.documentElement.scrollHeight - 80)) {
          ensureVisibleRevealed();
          return;
        }
        clearTimeout(settleTimer);
        settleTimer = setTimeout(ensureVisibleRevealed, 120);
      };
      window.addEventListener('scroll', onScrollSafety, { passive: true });

      ScrollTrigger.refresh();
      ensureVisibleRevealed();

      if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(function(){
          ScrollTrigger.refresh();
          ensureVisibleRevealed();
        });
      }

      return function(){
        clearTimeout(settleTimer);
        window.removeEventListener('scroll', onScrollSafety);
        rowEls.forEach(function(el){ delete el.dataset.ccRevealed; });
        if (bar.parentNode) bar.parentNode.removeChild(bar);
      };
    });

    // Desktop-only (>=900px) scrubbed parallax on big figures, clamped within tile gap (AGENTS.md §12.3)
    mm.add('(min-width: 900px) and (prefers-reduced-motion: no-preference)', function(){
      var figs = gsap.utils.toArray('.bento-big, .tm-figure');
      figs.forEach(function(fig){
        gsap.fromTo(fig, { '--py': 6 }, { '--py': -6, ease: 'none',
          scrollTrigger: { trigger: fig, start: 'top bottom', end: 'bottom top', scrub: 0.6 } });
      });
      return function(){
        figs.forEach(function(fig){ fig.style.removeProperty('--py'); });
      };
    });
  }

  // Memory Tunnel gallery (scroll-driven 3D photo tunnel), adapted from gallery part re-new.txt.
  (function initMemoryTunnel(){
    "use strict";

    var CONFIG = {
      selector: "#gallery",
      text: {
        intro: {
          eyebrow: "ความทรงจำจาก ComCamp #24",
          title: "ภาพรวม\nบรรยากาศปีที่แล้ว",
          subtitle: "ย้อนดูบรรยากาศจากค่ายปีที่แล้ว\nเลื่อนลงเพื่อเดินทางไปด้วยกัน",
        },
        outro: {
          eyebrow: "ComCamp #25",
          titleLines: ["แล้วพบกัน"],
          subtitle: "บทต่อไปของความทรงจำ กำลังรอให้คุณมาเขียนร่วมกัน",
          ctaLabel: "ดูข้อมูลการรับสมัคร",
          ctaHref: "#timeline",
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
      { file: "g02.jpg", alt: "นักเรียนและพี่เลี้ยงช่วยกันดูหน้าจอคอมพิวเตอร์ในห้องปฏิบัติการ" },
      { file: "g04.jpg", alt: "นักเรียนนั่งเรียนหน้าจอเต็มห้องคอมพิวเตอร์ มีผู้สอนยืนดูแลด้านหลัง" },
      { file: "g05.jpg", alt: "ผู้สอนช่วยนักเรียนเขียนโปรแกรมแบบบล็อกบนหน้าจอในห้องคอมพิวเตอร์" },
      { file: "g06.jpg", alt: "นักเรียนต่อแถวรับของว่างที่โต๊ะในโถงทางเดิน" },
      { file: "g08.jpg", alt: "นักเรียนรับขนมและนมกล่องที่โต๊ะในโถงทางเดิน" },
      { file: "g09.jpg", alt: "นักเรียนสองคนมองหน้าจอคอมพิวเตอร์ร่วมกันในห้องปฏิบัติการ" },
      { file: "g12.jpg", alt: "นักเรียนสี่คนรอบโต๊ะคอมพิวเตอร์ มีพี่เลี้ยง TA คอยช่วย" },
      { file: "g13.jpg", alt: "นักเรียนนั่งหน้าจอ มีพี่เลี้ยงยืนชี้หน้าจอให้คำแนะนำ" },
      { file: "g14.jpg", alt: "นักเรียนและพี่เลี้ยงรวมตัวดูหน้าจอคอมพิวเตอร์ในห้องปฏิบัติการ" },
      { file: "g16.jpg", alt: "พี่เลี้ยงตักซุปจากหม้อใหญ่แจกอาหารให้ผู้เข้าร่วม" },
      { file: "g17.jpg", alt: "พี่เลี้ยง TA ถือไมค์พูดกับนักเรียนในห้องคอมพิวเตอร์" },
      { file: "g18.jpg", alt: "นักเรียนนั่งทำงานหน้าจอคอมพิวเตอร์ในห้องปฏิบัติการ" },
      { file: "g19.jpg", alt: "ทีมพี่เลี้ยงเสื้อดำยืนบนเวที คนหนึ่งถือไมค์" },
      { file: "g20.jpg", alt: "พี่เลี้ยงสามคนพูดหน้าจอโปรเจกเตอร์และไวท์บอร์ด" },
      { file: "g22.jpg", alt: "พี่เลี้ยง TA ใช้ไมค์อธิบายหน้าแล็ปท็อปในห้องปฏิบัติการ" },
      { file: "g27.jpg", alt: "พี่เลี้ยงหลังโต๊ะอาหารจำนวนมากระหว่างแจกอาหารให้ผู้เข้าร่วม" },
      { file: "g29.jpg", alt: "ผู้เข้าร่วมฟังการนำเสนอหน้าจอโปรเจกเตอร์" },
      { file: "g30.jpg", alt: "วิทยากรบรรยายด้วยไมค์ให้นักเรียนฟังในห้องคอมพิวเตอร์" },
      { file: "g31.jpg", alt: "พี่เลี้ยงห้าคนยืนหน้าจอโปรเจกเตอร์ คนกลางถือไมค์พูด" },
      { file: "g33.jpg", alt: "วิทยากรพูดผ่านไมค์หน้าจอโปรเจกเตอร์และไวท์บอร์ด" },
      { file: "g34.jpg", alt: "นักเรียนและพี่เลี้ยงช่วยกันตรวจสอบอุปกรณ์ฮาร์ดแวร์คอมพิวเตอร์" },
      { file: "g35.jpg", alt: "ครูตักอาหารแจกนักเรียนที่เข้าแถวในโถงทางเดิน" },
      { file: "g36.jpg", alt: "กลุ่มนักเรียนเสื้อดำพูดนำเสนอหน้าห้อง" },
      { file: "g37.jpg", alt: "ผู้เข้าร่วมรวมตัวรอบโต๊ะแจกอาหารและขนมในโถงทางเดิน" },
      { file: "g39.jpg", alt: "ผู้เข้าร่วมพูดผ่านไมค์หน้าจอโปรเจกเตอร์ในห้องประชุม" },
      { file: "g40.jpg", alt: "กลุ่มพี่เลี้ยงบนเวที คนหนึ่งถือไมค์พูด" }
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
      st.transform = "translate3d(" + s.x.toFixed(1) + "px, " + s.y.toFixed(1) + "px, " + s.z.toFixed(1) + "px) rotate(" + s.rot.toFixed(2) + "deg)" +
        (s.scale && s.scale !== 1 ? " scale(" + s.scale.toFixed(3) + ")" : "");
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
    MotionEngine.prototype.resize = function(vw, vh, isMobile, cardW, cardH) {
      this.halfW = vw / 2; this.halfH = vh / 2; this.spread = isMobile ? this.m.spreadMobile : this.m.spread;
      this.layoutReduced(vw, vh, cardW, cardH);
    };
    MotionEngine.prototype.getState = function(i, t) {
      var it = this.items[i], local = (t - it.start) / this.duration;
      if (local <= 0 || local >= 1) return null;
      var nx, ny;
      if (it.fixed) { nx = it.fx; ny = it.fy; }
      else { var r = lerp(this.spread.minR, this.spread.maxR, it.radius); nx = Math.cos(it.angle) * r; ny = Math.sin(it.angle) * r; }
      var m = this.m;
      return {
        x: nx * this.halfW, y: ny * this.halfH,
        z: lerp(m.zStart, this.zEnd, local),
        rot: it.tilt,
        opacity: Math.min(progressBetween(local, 0, m.fadeIn), 1 - progressBetween(local, 1 - m.fadeOut, 1))
      };
    };
    MotionEngine.prototype.isNear = function(i, t) { return t >= this.items[i].start - this.m.preloadAhead; };

    // Reduced motion: no flight, no depth, no easing. The tunnel becomes a scroll-driven
    // slideshow — one group (groupSize photos) at a time, fully opaque, side by side
    // (wide screens) or stacked (tall phones), swapped instantly as the reader scrolls.
    MotionEngine.prototype.groupCount = function() { return Math.ceil(this.count / this.m.groupSize); };
    MotionEngine.prototype.reducedGroup = function(t) {
      if (t <= 0 || t >= 1) return -1;
      return Math.min(this.groupCount() - 1, Math.floor(t * this.groupCount()));
    };
    MotionEngine.prototype.layoutReduced = function(vw, vh, cardW, cardH) {
      var n = this.m.groupSize, w = cardW || 240, h = cardH || 180, gap = Math.round(w * 0.08);
      var maxScale = 1.6;
      var rowScale = Math.min(maxScale, (vw * 0.84) / (n * w + (n - 1) * gap), (vh * 0.62) / h);
      var colScale = Math.min(maxScale, (vw * 0.88) / w, (vh * 0.74) / (n * h + (n - 1) * gap));
      this.rl = rowScale >= colScale
        ? { row: true, scale: rowScale, step: (w + gap) * rowScale }
        : { row: false, scale: colScale, step: (h + gap) * colScale };
    };
    MotionEngine.prototype.getReducedState = function(i, t) {
      var g = this.reducedGroup(t), size = this.m.groupSize;
      if (g < 0 || Math.floor(i / size) !== g) return null;
      var inGroup = Math.min(size, this.count - g * size);
      var offset = ((i % size) - (inGroup - 1) / 2) * this.rl.step;
      return { x: this.rl.row ? offset : 0, y: this.rl.row ? 0 : offset, z: 0, rot: 0, scale: this.rl.scale, opacity: 1 };
    };

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
      this.reducedMq = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
      this.setReduced(REDUCED || !!(this.reducedMq && this.reducedMq.matches));
      var stage = this.root.querySelector('[data-mt="stage"]');
      if (!stage) return;
      this.stage = stage;
      this.renderer = new TunnelRenderer(stage, images, cfg.images);
      this.engine = new MotionEngine(images, cfg.motion);
      this.text = new SceneText(this.root, cfg);
      this.target = 0; this.current = 0; this.lastTime = 0; this.rafId = null; this.inView = false; this.entered = false;
      var self = this;
      this.tick = function(now){ self._tick(now); };
      this.onScroll = function(){ self.requestTick(); };
      this.onResize = debounce(function(){ self.measure(); self.requestTick(); }, 150);
      this.onReducedChange = function(e){ self.setReduced(!!e.matches); self.requestTick(); };
      this.init();
    }
    MemoryTunnel.prototype.setReduced = function(on) {
      this.reduced = on;
      this.root._mtReduced = on;
    };
    MemoryTunnel.prototype.init = function() {
      this.renderer.build();
      this.root.style.setProperty("--mt-perspective", this.cfg.motion.perspective + "px");
      this.measure();
      window.addEventListener("scroll", this.onScroll, { passive: true });
      window.addEventListener("resize", this.onResize);
      // Late layout shifts above the gallery (fonts, images) move it without a scroll event.
      window.addEventListener("load", this.onScroll);
      if (this.reducedMq) {
        if (this.reducedMq.addEventListener) this.reducedMq.addEventListener("change", this.onReducedChange);
        else if (this.reducedMq.addListener) this.reducedMq.addListener(this.onReducedChange);
      }
      this.requestTick();
    };
    MemoryTunnel.prototype.measureCard = function() {
      // Cards are display:none until active, so size a hidden probe with the same CSS vars.
      if (!this.probe) {
        this.probe = document.createElement("div");
        this.probe.setAttribute("aria-hidden", "true");
        this.probe.style.cssText = "position:absolute;left:0;top:0;visibility:hidden;pointer-events:none;width:var(--mt-card-w);height:var(--mt-card-h)";
        this.stage.appendChild(this.probe);
      }
      return { w: this.probe.offsetWidth, h: this.probe.offsetHeight };
    };
    MemoryTunnel.prototype.measure = function() {
      var mobile = window.matchMedia("(max-width: " + this.cfg.mobileBreakpoint + "px)").matches;
      var length = mobile ? this.cfg.scroll.lengthVhMobile : this.cfg.scroll.lengthVh;
      this.root.style.setProperty("--mt-length", length + "vh");
      var card = this.measureCard();
      this.engine.resize(window.innerWidth, window.innerHeight, mobile, card.w, card.h);
    };
    MemoryTunnel.prototype.requestTick = function() {
      if (this.rafId === null) this.rafId = requestAnimationFrame(this.tick);
    };
    MemoryTunnel.prototype._tick = function(now) {
      this.rafId = null;
      var rect = this.root.getBoundingClientRect(), vh = window.innerHeight;
      // Visibility straight from the rect (one viewport of margin each side). An
      // IntersectionObserver on this ~1400vh section under-reports in some in-app
      // WebViews, which left every card requested=false — an empty black tunnel.
      var inView = rect.bottom > -vh && rect.top < vh * 2;
      if (inView && !this.inView) this.renderer.preloadRange(0, this.cfg.motion.groupSize * 2);
      this.inView = inView;
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
      if (this.reduced && this.inView) {
        // Current + next group, so the next instant swap already has its photos.
        var size = this.cfg.motion.groupSize, g = Math.max(0, this.engine.reducedGroup(t));
        this.renderer.preloadRange(g * size, (g + 2) * size);
      }
      for (var i = 0; i < this.engine.count; i++) {
        // Only pull images once the tunnel is actually near the viewport —
        // preloading on init fetched ~7 full-size photos (≈1.2 MB) while the
        // gallery was still thousands of pixels offscreen.
        if (!this.reduced && this.inView && this.engine.isNear(i, t)) this.renderer.preload(i);
        var state = this.reduced ? this.engine.getReducedState(i, t) : this.engine.getState(i, t);
        if (!state) { this.renderer.setActive(i, false); continue; }
        this.renderer.setActive(i, true); this.renderer.apply(i, state);
      }
    };
    MemoryTunnel.prototype.destroy = function() {
      window.removeEventListener("scroll", this.onScroll);
      window.removeEventListener("resize", this.onResize);
      window.removeEventListener("load", this.onScroll);
      if (this.reducedMq) {
        if (this.reducedMq.removeEventListener) this.reducedMq.removeEventListener("change", this.onReducedChange);
        else if (this.reducedMq.removeListener) this.reducedMq.removeListener(this.onReducedChange);
      }
      if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    };

    window.memoryTunnel = new MemoryTunnel(CONFIG, MEMORY_IMAGES);
    applyHeroState();
  })();

  // Navbar: mobile disclosure + scroll-spy for the section in view.
  (function initNav(){
    var nav = document.querySelector('.site-nav');
    var menu = $('site-menu');
    var toggle = document.querySelector('.nav-toggle');
    var wideMq = window.matchMedia ? window.matchMedia('(min-width:900px)') : null;
    var isMobileNav = function(){
      return wideMq ? !wideMq.matches : window.innerWidth < 900;
    };
    var setOpen = function(open){
      if (!toggle || !menu) return;
      var mobile = isMobileNav();
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      menu.classList.toggle('is-open', open);
      menu.inert = !open && mobile;
      document.body.style.overflow = open && mobile ? 'hidden' : '';
    };
    if (menu && toggle && !toggle.dataset.ccNavBound){
      toggle.addEventListener('click', function(){ setOpen(toggle.getAttribute('aria-expanded') !== 'true'); });
      menu.addEventListener('click', function(e){ if (e.target.closest && e.target.closest('a')) setOpen(false); });
      document.addEventListener('keydown', function(e){
        if (e.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true'){ setOpen(false); toggle.focus(); }
      });
      if (wideMq) {
        var onWide = function(){
          if (wideMq.matches) {
            setOpen(false);
            menu.inert = false;
          } else {
            menu.inert = toggle.getAttribute('aria-expanded') !== 'true';
          }
        };
        if (wideMq.addEventListener) wideMq.addEventListener('change', onWide);
        else if (wideMq.addListener) wideMq.addListener(onWide);
      }
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
          nav.inert = hidden;
          if (hidden) setOpen(false);
        };
        var requestNav = function(){ if (!navTick) navTick = requestAnimationFrame(updateNav); };
        window.addEventListener('scroll', requestNav, { passive: true });
        window.addEventListener('resize', requestNav);
        window.addEventListener('load', updateNav);
        updateNav();
      }
      if (menu) {
        var links = Array.prototype.slice.call(menu.querySelectorAll('a[href^="#"]'));
        var targets = [];
        links.forEach(function(a){
          var href = a.getAttribute('href') || '';
          var id = href.slice(1);
          var el = id ? document.getElementById(id) : null;
          if (el) targets.push({ id: id, el: el, link: a });
        });
        if (targets.length) {
          var currentSpyId = null;
          var spyTick = 0;
          var updateSpy = function(){
            spyTick = 0;
            var navH = nav.offsetHeight || 64;
            var probeY = Math.max(navH + 40, Math.round(window.innerHeight * 0.35));
            var activeId = '';
            for (var i = 0; i < targets.length; i++) {
              if (targets[i].el.getBoundingClientRect().top <= probeY) {
                activeId = targets[i].id;
              }
            }
            if (activeId === currentSpyId) return;
            currentSpyId = activeId;
            links.forEach(function(a){ a.removeAttribute('aria-current'); });
            targets.forEach(function(t){
              if (t.id === activeId) t.link.setAttribute('aria-current', 'true');
            });
          };
          var requestSpy = function(){ if (!spyTick) spyTick = requestAnimationFrame(updateSpy); };
          window.addEventListener('scroll', requestSpy, { passive: true });
          window.addEventListener('resize', requestSpy);
          window.addEventListener('load', updateSpy);
          window.addEventListener('hashchange', updateSpy);
          updateSpy();
        }
      }
    }
  })();

  var gsapBooted = false;
  function bootGsapOnce(){
    if (gsapBooted) return;
    if (typeof gsap === 'undefined' || typeof ScrollTrigger === 'undefined') return;
    gsapBooted = true;
    initGsap();
  }
  bootGsapOnce();
  if (!gsapBooted) {
    document.addEventListener('DOMContentLoaded', bootGsapOnce, { once: true });
    window.addEventListener('load', bootGsapOnce, { once: true });
  } else if (document.readyState !== 'complete') {
    window.addEventListener('load', function(){
      try { if (typeof ScrollTrigger !== 'undefined') ScrollTrigger.refresh(); } catch(e){}
    }, { once: true });
  }
})();
