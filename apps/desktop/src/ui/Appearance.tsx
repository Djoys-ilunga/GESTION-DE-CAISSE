import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { SunMoon } from 'lucide-react';
type Theme = 'system' | 'light' | 'dark';
const key = 'caissepro.appearance';
export function Appearance() {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const locate = () => setSlot(document.getElementById('appearance-slot'));
    locate();
    const observer = new MutationObserver(locate);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const v = localStorage.getItem(key);
      return v === 'light' || v === 'dark' ? v : 'system';
    } catch {
      return 'system';
    }
  });
  useEffect(() => {
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    const update = () => {
      const resolved = theme === 'system' ? (media?.matches ? 'dark' : 'light') : theme;
      document.documentElement.dataset.theme = resolved;
      document.documentElement.style.colorScheme = resolved;
    };
    update();
    media?.addEventListener?.('change', update);
    return () => media?.removeEventListener?.('change', update);
  }, [theme]);
  const control = (
    <label className={`appearance-control${slot ? ' embedded' : ''}`}>
      <SunMoon size={17} />
      <span className="sr-only">Apparence</span>
      <select
        aria-label="Apparence"
        value={theme}
        onChange={(e) => {
          const v = e.target.value as Theme;
          setTheme(v);
          try {
            localStorage.setItem(key, v);
          } catch {
            /* Preference is optional; no sensitive data is stored. */
          }
        }}
      >
        <option value="system">Thème système</option>
        <option value="light">Thème clair</option>
        <option value="dark">Thème sombre</option>
      </select>
    </label>
  );
  return slot ? createPortal(control, slot) : control;
}
