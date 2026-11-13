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
    explicitClosed: false,
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
    var sticky = $('sticky-cta');
    var mini = $('sticky-mini');
    var seatsBig = $('bento-seats-num');
    var seatsCaption = $('bento-seats-caption');
    var extraCtas = document.querySelectorAll('[data-register-cta]');
    // Nobody can have applied before opening, so the status check has nothing to look up.
    if (secondary) secondary.style.display = (s === 'LOADING' || s === 'PRE_OPEN') ? 'none' : '';
    document.documentElement.setAttribute('data-reg-open', (s === 'OPEN' || s === 'ALMOST_FULL') ? 'true' : 'false');

    var maxCap = state.maxCapacity || MAX;
    var seatsLeft = Math.max(0, maxCap - state.currentCount);
    var ctaText = 'เปิดรับสมัคร 16 พ.ย.', ctaHref = '#experience', miniLabel = 'เปิดรับ 16 พ.ย. 69', stickyDisabled = true;
    var regCtaText = 'เปิดรับ 16 พ.ย. 69', regCtaHref = '/register', regCtaMuted = true;

    if (seatsBig) {
      seatsBig.innerHTML = maxCap + '<small>ที่นั่ง</small>';
      var seatsCard = seatsBig.closest ? seatsBig.closest('.bento-feature') : null;
      if (seatsCard) seatsCard.setAttribute('data-reg-state', s);
    }

    if (s === 'LOADING' || s === 'PRE_OPEN') {
      ctaText = 'เปิดรับสมัคร 16 พ.ย.';
      ctaHref = '#experience';
      regCtaText = 'เปิดรับ 16 พ.ย. 69';
      regCtaHref = '/register';
      regCtaMuted = true;
      miniLabel = 'เปิดรับ 16 พ.ย. 69';
      stickyDisabled = true;
      if (sticky) sticky.textContent = '16 พ.ย. 69';
      if (secondary) {
        secondary.textContent = 'ตรวจสอบสถานะใบสมัคร →';
        secondary.setAttribute('href', '/status');
      }
      if (seatsCaption) seatsCaption.textContent = 'จำนวนจำกัด คัดเลือกตามลำดับการสมัครและยืนยันสิทธิ์แบบ First-Come, First-Served';
    } else if (s === 'FAILED') {
      ctaText = 'ดูรายละเอียดค่าย';
      ctaHref = '#experience';
      regCtaText = 'ดูรายละเอียดค่าย';
      regCtaHref = '#experience';
      regCtaMuted = true;
      miniLabel = 'เชื่อมต่อไม่สำเร็จ';
      stickyDisabled = true;
      if (sticky) sticky.textContent = 'ตรวจสอบ';
      if (secondary) {
        secondary.textContent = 'ลองเชื่อมต่อใหม่ →';
        secondary.setAttribute('href', '#retry-status');
      }
      if (seatsCaption) seatsCaption.textContent = 'จำนวนจำกัด คัดเลือกตามลำดับการสมัครและยืนยันสิทธิ์แบบ First-Come, First-Served';
    } else if (s === 'OPEN') {
      ctaText = 'สมัครค่าย';
      ctaHref = '/register';
      regCtaText = 'สมัครค่าย';
      regCtaHref = '/register';
      regCtaMuted = false;
      miniLabel = 'เหลือ ' + seatsLeft + '/' + maxCap + ' ที่นั่ง';
      stickyDisabled = false;
      if (sticky) sticky.textContent = 'สมัครค่าย';
      if (secondary) {
        secondary.textContent = 'ตรวจสอบสถานะใบสมัคร →';
        secondary.setAttribute('href', '/status');
      }
      if (seatsCaption) seatsCaption.textContent = 'ขณะนี้เหลือที่นั่งว่าง ' + seatsLeft + ' จาก ' + maxCap + ' ที่นั่ง คัดเลือกตามลำดับการสมัครและยืนยันสิทธิ์ (First-Come, First-Served)';
    } else if (s === 'ALMOST_FULL') {
      ctaText = 'สมัครค่าย (เหลือ ' + seatsLeft + ' ที่นั่ง)';
      ctaHref = '/register';
      regCtaText = 'สมัครค่าย (เหลือ ' + seatsLeft + ')';
      regCtaHref = '/register';
      regCtaMuted = false;
      miniLabel = 'เหลือ ' + seatsLeft + ' ที่นั่ง';
      stickyDisabled = false;
      if (sticky) sticky.textContent = 'สมัคร';
      if (secondary) {
        secondary.textContent = 'ตรวจสอบสถานะใบสมัคร →';
        secondary.setAttribute('href', '/status');
      }
      if (seatsCaption) seatsCaption.textContent = 'ใกล้เต็มแล้ว! เหลือเพียง ' + seatsLeft + ' ที่นั่งสุดท้าย คัดเลือกแบบ First-Come, First-Served';
    } else if (s === 'FULL') {
      // /register is locked once the camp is full, so the CTA leads to the status page instead.
      ctaText = 'ที่นั่งเต็มแล้ว · ตรวจสอบสถานะ';
      ctaHref = '/status';
      regCtaText = 'ที่นั่งเต็มแล้ว · ตรวจสอบสถานะ';
      regCtaHref = '/status';
      regCtaMuted = true;
      miniLabel = 'ที่นั่งเต็มแล้ว';
      stickyDisabled = false;
      if (sticky) sticky.textContent = 'ตรวจสถานะ';
      // The primary CTA already leads to /status, so the secondary link points at the camp details.
      if (secondary) {
        secondary.textContent = 'ดูรายละเอียดค่าย →';
        secondary.setAttribute('href', '#experience');
      }
      if (seatsCaption) seatsCaption.textContent = 'ขณะนี้มีผู้สมัครครบ ' + maxCap + ' ที่นั่งแล้ว หากมีผู้สละสิทธิ์ระบบจะคืนที่นั่งว่างให้สมัครได้ทันที';
    } else { // CLOSED
      ctaText = 'ดูรายละเอียดค่าย';
      ctaHref = '#experience';
      regCtaText = 'ปิดรับสมัครแล้ว';
      regCtaHref = '/status';
      regCtaMuted = true;
      miniLabel = 'ปิดรับสมัครแล้ว';
      stickyDisabled = true;
      if (sticky) sticky.textContent = 'ปิดแล้ว';
      if (secondary) {
        secondary.textContent = 'ตรวจสอบสถานะใบสมัคร →';
        secondary.setAttribute('href', '/status');
      }
      if (seatsCaption) seatsCaption.textContent = 'ปิดรับสมัครแล้ว สามารถตรวจสอบสถานะใบสมัครได้ตลอดเวลา';
    }

    if (primary) {
      var primarySpan = primary.querySelector('span');
      if (primarySpan) {
        primarySpan.textContent = ctaText;
      } else {
        primary.textContent = ctaText;
      }
      primary.setAttribute('href', ctaHref);
    }

    if (extraCtas.length) {
      extraCtas.forEach(function(el){
        var target = el.querySelector('[data-register-cta-label]') || el.querySelector('span');
        if (target) {
          target.textContent = regCtaText;
        } else {
          el.textContent = regCtaText;
        }
        el.setAttribute('href', regCtaHref);
        el.setAttribute('data-reg-state', s);
        el.classList.toggle('is-pre-open', regCtaMuted);
      });
    }

    if (mini) mini.textContent = miniLabel;
    if (sticky) {
      sticky.disabled = stickyDisabled;
      sticky.setAttribute('aria-disabled', stickyDisabled ? 'true' : 'false');
    }
    checkMidnightResync();
  }

  // Midnight Zero Jitter Buffer (AGENTS.md §8): when a pre-open countdown reaches 00:00:00, every
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
    if (s === 'PRE_OPEN' || s === 'CLOSED' || s === 'LOADING') return;
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
        state.isOpen = Boolean(data.isOpen);
        state.explicitClosed = data.isOpen === false;
        state.currentCount = typeof data.currentCount === 'number' ? data.currentCount : 0;
        state.maxCapacity = typeof data.maxCapacity === 'number' && data.maxCapacity > 0 ? data.maxCapacity : MAX;
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
        // Graceful offline fallback per AGENTS.md §0.2 & §8
        state.loading = false;
        state.failed = false;
        state.isOpen = false;
        state.explicitClosed = false;
        state.serverTime = new Date().toISOString();
        state.serverOffsetMs = 0;
        state.registrationOpenAt = OPEN_AT;
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


  // Editorial immersive motion (sections 02–06 + footer + hero exit + page progress).
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

      // 2) Hero exit: copy lifts, stage drifts and softens as you scroll into 02
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
        var title = sec.querySelector('.section-title, .exp-title');
        var lead = sec.querySelector('.section-head .body, .exp-lead');
        var tl = gsap.timeline({ defaults: { ease: ease },
          scrollTrigger: { trigger: sec, start: 'top 92%', once: true, fastScrollEnd: true } });
        if (idx) tl.from(idx, { x: -16, opacity: 0, duration: 0.42, clearProps: 'transform,opacity' }, 0);
        if (title) tl.from(title, { yPercent: 28, opacity: 0, clipPath: 'inset(0 0 100% 0)', duration: 0.62, clearProps: 'clipPath,transform,opacity' }, 0.04);
        if (lead) tl.from(lead, { y: 12, opacity: 0, duration: 0.45, clearProps: 'transform,opacity' }, 0.12);
        revealTimelines.push({ el: sec, tl: tl });

        // Hairline draws left → right (container top rules use --rule-p)
        sec.querySelectorAll('.exp-list, .bento, .journey, .tm-bento, .faq').forEach(function(box){
          gsap.fromTo(box, { '--rule-p': 0 }, { '--rule-p': 1, duration: 0.95, ease: 'expo.out',
            scrollTrigger: { trigger: box, start: 'top 94%', once: true, fastScrollEnd: true } });
        });

        // Section 04 Journey (Option C): scrubbed numeral parallax, staged reveal, and contiguous active step spy
        if (sec.id === 'journey') {
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

      // 4) Row reveals: batched so rows entering together cascade (Section 04 handled with Option C choreography)
      var rowEls = gsap.utils.toArray('.exp-item, .bento .card, .tm-tile, .faq-item');
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
        // Only pull images once the tunnel is actually near the viewport —
        // preloading on init fetched ~7 full-size photos (≈1.2 MB) while the
        // gallery was still thousands of pixels offscreen.
        if (this.inView && this.engine.isNear(i, t)) this.renderer.preload(i);
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
      var wide = window.matchMedia('(min-width:900px)');
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
