import { DamascusTransitApp } from './transit-app';
import { getPassword, login, forgetPassword } from '../lib/auth';
import type { Locale } from '../lib/types';

/**
 * In-page password gate for the admin pages. The app stays hidden until the
 * user enters a valid password (or has one stored from a previous visit).
 * Logging out forgets the stored password and returns to the gate.
 */
export function initAdminGate(locale: Locale) {
  const app = document.getElementById('app') as HTMLElement;
  const gate = document.getElementById('gate') as HTMLElement;
  const form = document.getElementById('gate-form') as HTMLFormElement;
  const errorEl = document.getElementById('gate-error') as HTMLParagraphElement;
  const logoutBtn = document.getElementById('logout-btn');

  let started = false;
  const startApp = () => {
    if (started) return;
    started = true;
    gate.hidden = true;
    app.hidden = false;
    new DamascusTransitApp({
      mapEl: document.getElementById('map')!,
      sidebarEl: document.getElementById('line-list')!,
      editorEl: document.getElementById('line-editor')!,
      addLineBtn: document.getElementById('add-line-btn') as HTMLButtonElement,
      exportBtn: document.getElementById('export-btn') as HTMLButtonElement,
      importBtn: document.getElementById('import-btn') as HTMLButtonElement,
      importInput: document.getElementById('import-input') as HTMLInputElement,
      locale,
    });
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.hidden = true;
    const password = String(new FormData(form).get('password') ?? '');
    if (await login(password)) {
      startApp();
    } else {
      errorEl.hidden = false;
    }
  });

  logoutBtn?.addEventListener('click', () => {
    forgetPassword();
    window.location.reload();
  });

  // Already authenticated from a previous visit: skip the gate.
  if (getPassword()) startApp();
  else gate.hidden = false;
}
