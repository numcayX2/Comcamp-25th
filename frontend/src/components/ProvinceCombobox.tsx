import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { ChevronDown } from 'lucide-react';
import { canonicalProvince, PROVINCES, searchProvinces } from '../lib/provinces';

interface Props {
  id: string;
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  className?: string;
  style?: CSSProperties;
  invalid?: boolean;
  describedBy?: string;
  required?: boolean;
  placeholder?: string;
}

/**
 * Type-to-filter picker for the 77 provinces (WAI-ARIA combobox with a listbox popup). The value is
 * the text in the field; picking an option, or leaving the field on a recognised spelling
 * ("จ. ลำปาง", "กทม"), replaces it with the official name. Validation stays with the form.
 */
export function ProvinceCombobox({ id, value, onChange, onBlur, className, style, invalid, describedBy, required, placeholder = 'พิมพ์เพื่อค้นหาจังหวัด' }: Props) {
  const listId = `${useId()}-list`;
  const [open, setOpen] = useState(false);
  // What the list is filtered by: the typed text, or nothing when the list was opened to browse.
  const [filter, setFilter] = useState('');
  const [active, setActive] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const options = useMemo(() => (filter ? searchProvinces(filter) : [...PROVINCES]), [filter]);
  const optionId = (i: number) => `${listId}-${i}`;

  // On a phone the field can sit low, with the list running under the keyboard or a sticky action
  // bar: open upward when there is more room above, and size the list to the room it has.
  const [placement, setPlacement] = useState<{ up: boolean; maxHeight: number }>({ up: false, maxHeight: 288 });
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!open || !input) return;
    const update = () => {
      const rect = input.getBoundingClientRect();
      const viewport = window.visualViewport?.height ?? window.innerHeight;
      // Room left for sticky bars: the mobile action bar below, the progress bar or nav above.
      const below = viewport - rect.bottom - 112;
      const above = rect.top - 96;
      const up = below < 200 && above > below;
      const maxHeight = Math.max(160, Math.min(288, up ? above : below));
      setPlacement((prev) => (prev.up === up && prev.maxHeight === maxHeight ? prev : { up, maxHeight }));
    };
    update();
    const vv = window.visualViewport;
    vv?.addEventListener('resize', update, { passive: true });
    return () => {
      vv?.removeEventListener('resize', update);
    };
  }, [open]);

  // Keep the highlighted option visible by scrolling the list itself, never the page.
  useEffect(() => {
    const list = listRef.current;
    const opt = open && active >= 0 ? document.getElementById(`${listId}-${active}`) : null;
    if (!list || !opt) return;
    if (opt.offsetTop < list.scrollTop) list.scrollTop = opt.offsetTop;
    else if (opt.offsetTop + opt.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = opt.offsetTop + opt.offsetHeight - list.clientHeight;
    }
  }, [open, active, options, listId, placement]);

  /** Opens the whole list to browse, with the current province highlighted. */
  function openList() {
    setFilter('');
    setActive(Math.max(0, PROVINCES.indexOf(value as (typeof PROVINCES)[number])));
    setOpen(true);
  }

  function pick(name: string) {
    onChange(name);
    setFilter('');
    setOpen(false);
    setActive(-1);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (!open) openList();
        else setActive((i) => Math.min(options.length - 1, i + 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (!open) openList();
        else setActive((i) => Math.max(0, i - 1));
        break;
      case 'Home':
      case 'End':
        if (open && options.length) {
          e.preventDefault();
          setActive(e.key === 'Home' ? 0 : options.length - 1);
        }
        break;
      case 'Enter':
        if (open && options[active]) {
          e.preventDefault();
          pick(options[active]);
        }
        break;
      case 'Escape':
        if (open) {
          // Close only the popup, not a dialog or editor around it.
          e.preventDefault();
          e.stopPropagation();
          setOpen(false);
        }
        break;
    }
  }

  return (
    <div className="pcb">
      <input
        ref={inputRef}
        id={id}
        name={id}
        type="text"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open && active >= 0 && options[active] ? optionId(active) : undefined}
        aria-required={required || undefined}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        autoComplete="off"
        spellCheck={false}
        className={className}
        style={{ ...style, paddingRight: 40 }}
        placeholder={placeholder}
        value={value}
        onChange={(e) => {
          const next = e.target.value;
          onChange(next);
          setFilter(next);
          setActive(next ? 0 : -1);
          setOpen(true);
        }}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={onKeyDown}
        onBlur={() => {
          setOpen(false);
          const official = canonicalProvince(value);
          if (official && official !== value) onChange(official);
          onBlur?.();
        }}
      />
      <ChevronDown className="pcb__chevron" size={16} strokeWidth={1.5} aria-hidden="true" />
      <ul
        ref={listRef}
        id={listId}
        role="listbox"
        aria-label="จังหวัด"
        className={`pcb__list${placement.up ? " pcb__list--up" : ""}`}
        style={{ maxHeight: placement.maxHeight }}
        hidden={!open}
        // Keep focus in the field while an option is clicked or tapped.
        onMouseDown={(e) => e.preventDefault()}
      >
        {options.length === 0 ? (
          <li className="pcb__empty" role="presentation">
            ไม่พบจังหวัดนี้ ลองพิมพ์ชื่ออื่น
          </li>
        ) : (
          options.map((name, i) => (
            <li
              key={name}
              id={optionId(i)}
              role="option"
              aria-selected={name === value}
              className={`pcb__opt${i === active ? ' is-active' : ''}`}
              onClick={() => pick(name)}
              onMouseMove={() => i !== active && setActive(i)}
            >
              {name}
            </li>
          ))
        )}
      </ul>
    </div>
  );
}
