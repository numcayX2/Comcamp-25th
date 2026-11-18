/**
 * Home-page GSAP bootstrap.
 *
 * `public/theme/main.js` is a plain (non-bundled) script that drives the editorial scroll motion
 * through `window.gsap` + `window.ScrollTrigger`. Those used to come from a second copy of GSAP on
 * cdnjs; now they come from the same npm `gsap` instance the hero already bundles, so the page ships
 * one GSAP runtime, same-origin, with no third-party CDN dependency in FB/LINE in-app browsers.
 * main.js boots on DOMContentLoaded / load once both globals exist.
 */
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

gsap.registerPlugin(ScrollTrigger);

Object.assign(window, { gsap, ScrollTrigger });
