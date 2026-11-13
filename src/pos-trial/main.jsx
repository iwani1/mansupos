import React from 'react';
import { createRoot } from 'react-dom/client';
import PracticeApp from './PracticeApp.jsx';
import './practice.css';

createRoot(document.getElementById('root')).render(<React.StrictMode><PracticeApp /></React.StrictMode>);
