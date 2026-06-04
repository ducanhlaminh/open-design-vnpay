/**
 * T39 — React Router v6 setup
 * Replaces Next.js app/ routing.
 */
import { createBrowserRouter } from 'react-router-dom';
import { RootLayout } from './layouts/RootLayout';
import { lazy, Suspense } from 'react';

const HomePage = lazy(() => import('./pages/HomePage'));
const ProjectPage = lazy(() => import('./pages/ProjectPage'));
const DesignSystemsPage = lazy(() => import('./pages/DesignSystemsPage'));
const SkillsPage = lazy(() => import('./pages/SkillsPage'));
const RoutinesPage = lazy(() => import('./pages/RoutinesPage'));
const MediaPage = lazy(() => import('./pages/MediaPage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));
const OnboardingPage = lazy(() => import('./pages/OnboardingPage'));
const NotFoundPage = lazy(() => import('./pages/NotFoundPage'));

function LazyPage({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<div className="page-loading" />}>{children}</Suspense>;
}

export const router = createBrowserRouter([
  {
    path: '/',
    element: <RootLayout />,
    children: [
      {
        index: true,
        element: <LazyPage><HomePage /></LazyPage>,
      },
      {
        path: 'projects/:id',
        element: <LazyPage><ProjectPage /></LazyPage>,
      },
      {
        path: 'design-systems',
        element: <LazyPage><DesignSystemsPage /></LazyPage>,
      },
      {
        path: 'skills',
        element: <LazyPage><SkillsPage /></LazyPage>,
      },
      {
        path: 'routines',
        element: <LazyPage><RoutinesPage /></LazyPage>,
      },
      {
        path: 'media',
        element: <LazyPage><MediaPage /></LazyPage>,
      },
      {
        path: 'settings',
        element: <LazyPage><SettingsPage /></LazyPage>,
      },
      {
        path: 'onboarding',
        element: <LazyPage><OnboardingPage /></LazyPage>,
      },
    ],
  },
  {
    path: '*',
    element: <LazyPage><NotFoundPage /></LazyPage>,
  },
]);
