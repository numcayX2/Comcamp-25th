/* Hallmark · macrostructure: Tabular Document · genre: editorial · anchor hue: green ~135
   Swiss preview — GSAP choreography.
   Motion budget is THREE primitives, not seventeen:
     1. hero line-mask reveal (one orchestrated entrance on first load)
     2. journey rail draw + step scroll-spy (carries meaning: how far along you are)
     3. capacity count-up
   Everything below the hero just *is there*. Reduced motion short-circuits all of it.
   Every tween is from() with immediateRender:false, so a failed CDN or a blocked
   script never leaves content hidden. */
(function () {
  'use strict';

  var OPEN_AT = '2026-11-16T00:00:00+07:00';
  var REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- live countdown (functional, not motion) ---------- */
  function tickCountdown() {
    var p = document.querySelector('.countdown');
    if (!p) return;
    var dEl = p.querySelector('[data-cd-d]');
    var tEl = p.querySelector('[data-cd-t]');
    if (!dEl || !tEl) return;
    var diff = new Date(OPEN_AT).getTime() - Date.now();
    if (!isFinite(diff) || diff <= 0) { p.textContent = 'เปิดรับสมัครแล้ว'; return; }
    var total = Math.floor(diff / 1000);
    var d = Math.floor(total / 86400);
    var h = String(Math.floor((total % 86400) / 3600)).padStart(2, '0');
    var m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
    var s = String(total % 60).padStart(2, '0');
    dEl.textContent = String(d);
    tEl.textContent = h + ':' + m + ':' + s;
  }
  tickCountdown();

  /* don't burn a phone battery while the tab is backgrounded */
  var timer = null;
  function startTimer() { if (!timer) timer = setInterval(tickCountdown, 1000); }
  function stopTimer() { clearInterval(timer); timer = null; }
  startTimer();
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { stopTimer(); } else { tickCountdown(); startTimer(); }
  });

  function init() {
    if (REDUCED) return;
    if (!window.gsap || !window.ScrollTrigger) return;
    gsap.registerPlugin(ScrollTrigger);

    /* ---------- 1 · hero entrance, the only orchestrated reveal ----------
       Opacity + a 12px lift, nothing else. No clip-path and no translate
       inside an overflow mask: Thai marks sit above and below the line box,
       so any mask strands tone marks on screen, and a clip that starts at
       inset(100%) hides the headline until JS finishes — which breaks the
       server-rendered first-paint rule if rAF is throttled. */
    gsap.timeline({ defaults: { ease: 'expo.out' } })
      .from('.hero-line > span', { opacity: 0.01, y: 12, duration: 0.8, stagger: 0.12, immediateRender: false }, 0)
      .from('.hero-kicker', { opacity: 0, duration: 0.6, immediateRender: false }, 0)
      .from('.hero-lede', { opacity: 0, y: 14, duration: 0.8, immediateRender: false }, 0.34)
      .from('.hero-actions > *', { opacity: 0, y: 12, duration: 0.7, stagger: 0.07, immediateRender: false }, 0.46)
      .from('.hero-meta > div', { opacity: 0, duration: 0.6, stagger: 0.05, immediateRender: false }, 0.56)
      .from('.hero-figure', { opacity: 0, duration: 0.8, immediateRender: false }, 0.5);

    /* ---------- 2 · journey rail draws as you pass it ---------- */
    var rail = document.querySelector('.rail');
    if (rail) {
      gsap.set(rail, { scaleY: 0 });
      gsap.to(rail, {
        scaleY: 1, ease: 'none',
        scrollTrigger: { trigger: '.journey', start: 'top 72%', end: 'bottom 72%', scrub: 0.4 }
      });
      document.querySelectorAll('.step').forEach(function (step) {
        ScrollTrigger.create({
          trigger: step, start: 'top 68%', end: 'bottom 55%',
          onEnter: function () { step.classList.add('is-active'); },
          onLeave: function () { step.classList.remove('is-active'); },
          onEnterBack: function () { step.classList.add('is-active'); },
          onLeaveBack: function () { step.classList.remove('is-active'); }
        });
      });
    }

    /* ---------- 3 · capacity count-up ---------- */
    document.querySelectorAll('[data-count]').forEach(function (el) {
      var target = parseFloat(el.getAttribute('data-count'));
      var proxy = { v: 0 };
      gsap.to(proxy, {
        v: target, duration: 1.4, ease: 'power2.out',
        scrollTrigger: { trigger: el, start: 'top 92%', once: true },
        onUpdate: function () { el.textContent = Math.round(proxy.v); }
      });
    });
  }

  if (document.readyState === 'complete') init();
  else window.addEventListener('load', init);
})();
