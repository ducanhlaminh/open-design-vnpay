import { HashRouter, Routes, Route } from 'react-router-dom'
import Home from './screens/home'

// Full-app view (`dist/index.html`): every screen wired into one HashRouter so a
// reviewer can click through the real navigation. Each screen also builds on its
// own into `dist/screens/<slug>.html` for the all-screens canvas (see vite.config).
// Screens DEFAULT-export their component; add one <Route> per screen here.
export function App() {
  return (
    <HashRouter>
      <Routes>
        <Route path="/" element={<Home />} />
      </Routes>
    </HashRouter>
  )
}
