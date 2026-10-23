import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { bootRunHive } from '@/components/benchmark/run-mode/run-hive';
import { loadViewState } from '@/lib/view-state';
import 'overlayscrollbars/overlayscrollbars.css'; // before index.css: .os-theme-hive outranks the lib's .os-scrollbar defaults by order only
import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('index.html has no #root');
// The view state and a benchmark run's Hive (#469) before the first render: the dashboard never jumps to the stored layout, and the write
// gate is in place before any control can write
void Promise.all([loadViewState(), bootRunHive()]).then(() => createRoot(root).render(<StrictMode><App /></StrictMode>));
