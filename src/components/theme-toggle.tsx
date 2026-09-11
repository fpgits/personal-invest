"use client";

import { useSyncExternalStore } from "react";
import { Moon, Sun } from "lucide-react";

/**
 * Blanco por defecto, negro a un clic. La eleccion se guarda en el navegador y
 * se aplica antes de pintar (ver el script en el layout) para que no haya
 * fogonazo blanco al cargar en oscuro.
 */
export type Theme = "light" | "dark";

export const THEME_KEY = "invest_theme";

/** Script que corre antes de pintar. Se inyecta tal cual en el <head>. */
export const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem(${JSON.stringify(THEME_KEY)});if(t==="dark"){document.documentElement.setAttribute("data-theme","dark");}}catch(e){}})();`;

/**
 * El tema vive en el DOM (el atributo que puso el script del layout), no en
 * un estado de React. Asi no hay dos verdades ni un primer render con el tema
 * equivocado: React se SUSCRIBE al DOM en vez de duplicarlo.
 */
const EVENT = "invest:theme";

function subscribe(onChange: () => void): () => void {
  window.addEventListener(EVENT, onChange);
  return () => window.removeEventListener(EVENT, onChange);
}

function currentTheme(): Theme {
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

function apply(theme: Theme) {
  const root = document.documentElement;
  if (theme === "dark") root.setAttribute("data-theme", "dark");
  else root.removeAttribute("data-theme");
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* navegador sin almacenamiento: el tema dura la sesion */
  }
  window.dispatchEvent(new Event(EVENT));
}

export function ThemeToggle() {
  // En el servidor siempre claro: es el de por defecto y el script del layout
  // corrige antes de pintar si hace falta.
  const theme = useSyncExternalStore(subscribe, currentTheme, () => "light" as Theme);

  function toggle() {
    apply(theme === "dark" ? "light" : "dark");
  }

  return (
    <button
      onClick={toggle}
      aria-label={theme === "dark" ? "Cambiar a tema claro" : "Cambiar a tema oscuro"}
      className="flex items-center gap-2 border border-border px-2 py-1 text-faint transition hover:text-text"
    >
      {theme === "dark" ? <Sun size={12} /> : <Moon size={12} />}
      <span className="label">{theme === "dark" ? "claro" : "oscuro"}</span>
    </button>
  );
}
