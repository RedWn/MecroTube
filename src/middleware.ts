import { defineMiddleware } from 'astro:middleware';
import { isAuthenticated } from './lib/auth';

export const onRequest = defineMiddleware(({ url, request, redirect }, next) => {
  const path = url.pathname;
  const isAdminPage = path === '/admin' || path.startsWith('/admin/') ||
    path === '/ar/admin' || path.startsWith('/ar/admin/');
  if (!isAdminPage) return next();
  if (isAuthenticated(request)) return next();

  const loginPath = path.startsWith('/ar') ? '/ar/login' : '/login';
  const backTo = encodeURIComponent(path);
  return redirect(`${loginPath}?to=${backTo}`);
});
