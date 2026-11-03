import React, { useState, useEffect } from 'react';
import { Sun, Moon } from 'lucide-react';

export const ThemeToggle: React.FC<{ className?: string }> = ({ className = '' }) => {
  const [isDark, setIsDark] = useState<boolean>(false);

  useEffect(() => {
    const isDarkMode = document.documentElement.classList.contains('dark');
    setIsDark(isDarkMode);
  }, []);

  const toggleTheme = () => {
    const nextDark = !isDark;
    setIsDark(nextDark);

    if (nextDark) {
      document.documentElement.classList.add('dark');
      document.documentElement.setAttribute('data-theme', 'dark');
      localStorage.setItem('comcamp-theme', 'dark');
    } else {
      document.documentElement.classList.remove('dark');
      document.documentElement.setAttribute('data-theme', 'light');
      localStorage.setItem('comcamp-theme', 'light');
    }
  };

  return (
    <button
      onClick={toggleTheme}
      aria-label="Toggle Light / Dark mode"
      title={isDark ? "เปลี่ยนเป็นโหมดสว่าง (Light Mode)" : "เปลี่ยนเป็นโหมดมืด (Dark Mode)"}
      className={`w-9 h-9 sm:w-10 sm:h-10 rounded-full border border-[var(--color-border)] bg-[var(--bg-canvas)]/80 hover:bg-[var(--bg-surface)] text-[var(--color-ink)] transition-all duration-300 backdrop-blur-md cursor-pointer flex items-center justify-center pointer-events-auto hover:border-[var(--color-tech)] shadow-xs ${className}`}
    >
      {isDark ? (
        <Sun className="w-4 h-4 text-[var(--color-warning)] transition-transform duration-300 hover:rotate-45" />
      ) : (
        <Moon className="w-4 h-4 text-[var(--color-tech)] transition-transform duration-300 hover:-rotate-12" />
      )}
    </button>
  );
};
