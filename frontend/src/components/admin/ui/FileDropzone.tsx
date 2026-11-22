import { useId, useState, type DragEvent, type ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { FileText, Upload } from 'lucide-react';
import { FADE, FADE_EXIT, PILL_SPRING, SIZE_SPRING, isFinePointer } from './motion';

export type DropzoneFile = { name: string; size: number; type?: string };

type Props = {
  /** `accept` for the file input, e.g. "application/pdf,image/jpeg,image/png,image/webp". */
  accept: string;
  /** Called with the picked/dropped file; the caller validates and uploads it. */
  onFile: (file: File) => void;
  /** Title line, e.g. "แนบฟอร์มที่เซ็นแล้ว". */
  label: ReactNode;
  /** Second line, e.g. "PDF หรือรูปภาพ ไม่เกิน 8 MB". */
  hint?: ReactNode;
  /** File to show in the card (the chosen one, or the one already on the server). */
  file?: DropzoneFile | null;
  /** Extra controls on the file card (view / remove ...). */
  fileActions?: ReactNode;
  disabled?: boolean;
  /** Upload in progress: the card shows `busyText` and the zone ignores input. */
  busy?: boolean;
  busyText?: ReactNode;
  /** Compact height for tight rows. */
  compact?: boolean;
  id?: string;
  describedBy?: string;
};

const LIFT_REGULAR = { rest: { x: 0, y: 0 }, hover: { x: 6, y: -6 } } as const;
const LIFT_COMPACT = { rest: { x: 0, y: 0 }, hover: { x: 4, y: -4 } } as const;
const GHOST = { rest: { opacity: 0 }, hover: { opacity: 1 } } as const;

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Aceternity "File Upload": the whole zone is the label of a visually hidden (still focusable)
 * file input, so click, keyboard and screen readers work without script tricks; drag-and-drop is
 * an extra on pointer devices. The icon tile lifts off its dashed outline on fine-pointer hover or
 * drag (suppressed under reduced motion), and the chosen file card enters cleanly below.
 */
export function FileDropzone({
  accept,
  onFile,
  label,
  hint,
  file,
  fileActions,
  disabled,
  busy,
  busyText,
  compact,
  id,
  describedBy,
}: Props) {
  const autoId = useId();
  const inputId = id ?? `dz-${autoId}`;
  const reduce = Boolean(useReducedMotion());
  const [drag, setDrag] = useState(false);
  const [hovered, setHovered] = useState(false);
  const off = Boolean(disabled || busy);
  const showCard = Boolean(file || busy);
  const lifted = !off && !reduce && (drag || hovered);
  const liftVariants = compact ? LIFT_COMPACT : LIFT_REGULAR;

  const take = (list: FileList | null | undefined) => {
    const f = list?.[0];
    if (f && !off) onFile(f);
  };

  const onDragOver = (e: DragEvent) => {
    if (off) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (!drag) setDrag(true);
  };

  const onDrop = (e: DragEvent) => {
    if (off) return;
    e.preventDefault();
    setDrag(false);
    take(e.dataTransfer.files);
  };

  return (
    <div className="w-full">
      <label
        htmlFor={inputId}
        onPointerEnter={(e) => {
          if (!off && isFinePointer(e)) setHovered(true);
        }}
        onPointerLeave={() => setHovered(false)}
        onPointerCancel={() => setHovered(false)}
        onDragOver={onDragOver}
        onDragEnter={onDragOver}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrag(false);
        }}
        onDrop={onDrop}
        aria-disabled={off || undefined}
        className={`group/dz relative flex w-full items-center gap-4 overflow-hidden rounded-[24px] border border-dashed bg-[var(--bg-surface)] text-left transition-colors duration-200 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--color-tech)] has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-[var(--bg-card)] motion-reduce:transition-none ${
          compact ? 'p-3' : 'p-4 sm:p-5'
        } ${off ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}
        style={{ borderColor: drag ? 'var(--color-tech)' : 'var(--color-border-input)' }}
      >
        <input
          id={inputId}
          type="file"
          accept={accept}
          disabled={off}
          aria-describedby={describedBy}
          className="sr-only"
          onChange={(e) => {
            take(e.target.files);
            e.target.value = '';
          }}
        />

        <span className={`relative shrink-0 ${compact ? 'h-12 w-12' : 'h-14 w-14'}`} aria-hidden="true">
          {!reduce && (
            <motion.span
              initial={false}
              animate={lifted ? 'hover' : 'rest'}
              variants={GHOST}
              transition={lifted ? FADE : FADE_EXIT}
              className="absolute inset-0 rounded-[12px] border border-dashed"
              style={{ borderColor: 'var(--color-tech)' }}
            />
          )}
          <motion.span
            initial={false}
            animate={lifted ? 'hover' : 'rest'}
            variants={liftVariants}
            transition={PILL_SPRING}
            className="absolute inset-0 flex items-center justify-center rounded-[12px] bg-[var(--bg-card)] transition-[box-shadow,color] duration-200 motion-reduce:transition-none"
            style={{
              color: drag ? 'var(--color-tech)' : 'var(--color-ink-muted)',
              boxShadow: lifted || (!off && drag) ? 'var(--shadow-float)' : 'var(--shadow-card)',
            }}
          >
            <Upload size={18} strokeWidth={1.5} />
          </motion.span>
        </span>

        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold leading-[1.5]" style={{ color: 'var(--color-ink)' }}>
            {drag ? 'วางไฟล์ที่นี่' : label}
          </span>
          {hint && (
            <span className="mt-0.5 block text-xs leading-[1.6]" style={{ color: 'var(--color-ink-subtle)' }}>
              {hint}
            </span>
          )}
        </span>
      </label>

      <AnimatePresence initial={false}>
        {showCard && (
          <motion.div
            key="card"
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: -6, scale: 0.98 }}
            animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
            exit={
              reduce
                ? { opacity: 0, transition: FADE_EXIT }
                : { opacity: 0, y: -4, scale: 0.98, transition: FADE_EXIT }
            }
            transition={reduce ? FADE : { ...SIZE_SPRING, opacity: FADE }}
            className="mt-2 flex min-w-0 origin-top-left flex-wrap items-center gap-x-3 gap-y-2 rounded-[12px] bg-[var(--bg-card)] px-3 py-2.5 [box-shadow:var(--shadow-card)]"
          >
            <FileText aria-hidden="true" size={16} strokeWidth={1.5} className="shrink-0" style={{ color: 'var(--color-ink-subtle)' }} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm" style={{ color: 'var(--color-ink)' }}>
                {busy ? busyText : file?.name}
              </span>
              {!busy && file && (
                <span className="font-mono text-xs tabular-nums" style={{ color: 'var(--color-ink-subtle)' }}>
                  {formatSize(file.size)}
                </span>
              )}
            </span>
            {!busy && fileActions && <span className="flex flex-wrap items-center gap-2">{fileActions}</span>}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
