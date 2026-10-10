import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { loadViewState } from '@/lib/view-state';
import 'overlayscrollbars/overlayscrollbars.css'; // before index.css: .os-theme-hive outranks the lib's .os-scrollbar defaults by order only
import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('index.html has no #root');
// The view state before the first render (#484): the dashboard never shows its defaults and then jumps to the stored layout
void loadViewState().then(() => createRoot(root).render(<StrictMode><App /></StrictMode>));
