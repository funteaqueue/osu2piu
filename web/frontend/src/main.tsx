import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import ChartPage from './pages/ChartPage';
import HomePage from './pages/HomePage';
import ProjectPage from './pages/ProjectPage';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/p/:id" element={<ProjectPage />} />
        <Route path="/p/:id/c/:chartId" element={<ChartPage />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
);
