import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { DetachedWindow } from './DetachedWindow.tsx';
import { bootRunHive } from '@/components/benchmark/run-mode/run-hive';
import { loadViewState, setViewWrites } from '@/lib/view-state';
import 'overlayscrollbars/overlayscrollbars.css'; // before index.css: .os-theme-hive outranks the lib's .os-scrollbar defaults by order only
import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('index.html has no #root');
// A detached window (#553) is the Hive's own page with ?window=<id>&activity=<key>: it reads the main window's view state and never
// writes it, and has no benchmark run of its own; with only one of the two it is the main window's page, as before
const params = new URLSearchParams(location.search);
const activity = params.get('activity');
const isWindow = params.get('window') !== null && activity !== null && activity !== '';
if (isWindow) setViewWrites(false); // before the load, so no control can write in between
// The view state and a benchmark run's Hive (#469) before the first render: the dashboard never jumps to the stored layout, and the write
// gate is in place before any control can write
const page = isWindow ? <DetachedWindow activity={activity} /> : <App />;
void Promise.all([loadViewState(), isWindow ? undefined : bootRunHive()]).then(() => createRoot(root).render(<StrictMode>{page}</StrictMode>));
