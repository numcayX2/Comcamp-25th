/**
 * Shared look for the /admin staff screens. Only theme tokens from global.css are used, so light
 * and dark mode both follow the same variables (AGENTS §4 / §11).
 */
export const INK = 'var(--color-ink)';
export const INK_2 = 'var(--color-ink-muted)';
export const INK_3 = 'var(--color-ink-subtle)';
export const RULE = 'var(--color-border)';
export const INPUT_BORDER = 'var(--color-border-input)';
export const SURFACE_SUBTLE = 'var(--bg-surface)';
export const BTN_DARK = 'var(--color-btn-dark)';
export const BTN_DARK_TEXT = 'var(--color-btn-dark-text)';
export const TECH = 'var(--color-tech)';
export const DANGER = 'var(--color-danger)';
export const SUCCESS = 'var(--color-success)';
export const WARNING = 'var(--color-warning)';

/** Focus treatment for every interactive control (AGENTS §11.3). */
export const FOCUS =
  'outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-tech)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-canvas)]';

/** Text field without its corner radius, so each caller picks rounded-xl (form) or rounded-full (search). */
export const INPUT_BASE = `w-full border bg-[var(--bg-card)] px-3.5 py-3 text-base leading-6 transition-colors placeholder:text-[var(--color-ink-subtle)] ${FOCUS}`;

/** Quiet full-pill button with a hairline border. */
export const PILL_GHOST = `rounded-full border px-4 py-2 text-sm font-semibold transition-colors hover:bg-[var(--color-btn-ghost-hover)] disabled:opacity-50 ${FOCUS}`;
