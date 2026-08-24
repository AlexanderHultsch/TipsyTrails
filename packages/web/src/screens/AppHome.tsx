import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getBars, getCityBoundary, getProgress } from '../api/client.js';
import type { BoundaryFeatureCollection } from '../api/geo-types.js';
import { BottomNav } from '../components/BottomNav.js';
import { Wordmark } from '../components/Wordmark.js';
import { pointsOfGeometry, svgPathOfGeometry } from '../geo/geojson-path.js';
import { computeBoundingBox, createProjector } from '../geo/project.js';

// The backdrop is drawn into a square viewBox and then stretched over the
// screen with preserveAspectRatio="slice", so what a phone shows is a *crop*
// of Karlsruhe rather than the whole outline shrunk to fit - the owner asked
// for "ein Ausschnitt der Karlsruhe-Karte", and a complete city sitting
// politely inside the screen is the city overview (Section 8.3), which already
// exists one tab away.
const BACKDROP_SIZE = 320;

// Section 8.3's start screen. Every authenticated entry path lands here
// (Login, Register, ChangePassword and the route guards all redirect to
// /app), so this is the first thing a player sees after signing in and the
// last thing they see before the map. It is not a tab - Section 8.4's five
// tabs do not include it - so it is passed through rather than lived on, and
// "open the map" is genuinely its one action.
//
// Three things, in this order of importance: the wordmark, the way in, and -
// quietly, underneath - what this player has done so far.
//
// WHY THE BACKDROP IS NOT A MAP. "Ein stark vernebelter Ausschnitt der
// Karlsruhe-Karte" reads as an instruction to mount MapLibre, and it is the
// wrong reading on this screen of all screens. The map route is lazily loaded
// on purpose (App.tsx: MapLibre and PMTiles are ~250 KB gzipped and must not
// enter the shell chunk), and putting them on the first authenticated paint
// would undo that on the one screen whose whole job is to be fast and strong.
// The real fog additionally needs GET /api/fog - an authenticated binary mask,
// the heaviest request the game makes - and WebGL2, which is not guaranteed
// (map/fog/ carries a 2D canvas fallback precisely because of that).
// Decoration must never be the thing that fails, and Section 7.3's fog is a
// mechanic rather than a texture: a second decorative copy of it would either
// duplicate the renderer or drift from it.
//
// So the backdrop is built from what screens/CityOverview.tsx already uses -
// the real city outline from GET /static/<slug>/city.geojson, projected by
// geo/project.ts and drawn as one inline SVG path. Real Karlsruhe, no WebGL,
// no tiles, no session, and the fog is the app's own ink at low alpha
// (index.css, .home-backdrop__city) rather than a shader.
export function AppHome() {
  const [city, setCity] = useState<BoundaryFeatureCollection | null>(null);
  const [stats, setStats] = useState<HomeStats | null>(null);

  // Two effects rather than one Promise.all, because the backdrop and the
  // numbers fail independently and neither may take the other down with it: a
  // city outline that 404s must not blank the three figures, and a progress
  // request that times out must not leave the screen without its atmosphere.
  useEffect(() => {
    let cancelled = false;
    getCityBoundary()
      .then((boundary) => {
        if (!cancelled) setCity(boundary);
      })
      .catch(() => {
        // Deliberately silent, and this is the whole degradation story for the
        // backdrop. It is atmosphere: the wordmark and the action are the
        // screen. An error message or a "loading the outline…" line on the
        // entry screen would be strictly worse than a plainer entry screen.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // WHERE THE THREE NUMBERS COME FROM, since there were several ways and none
  // of them is free. GET /api/progress answers the percent - the same
  // city.percent screens/CityOverview.tsx renders, so the two screens cannot
  // disagree about how much of Karlsruhe this player has walked. GET /api/bars
  // answers the other two from one list: its length is what has been
  // discovered, and the `mastered` flag that Section 5.7 puts on every bar is
  // what has been mastered - the same flag the map's markers are drawn from,
  // so "7 bars mastered" here and seven emptied glasses out there are one
  // fact and not two.
  //
  // GET /api/profile/:handle was the alternative and it loses on arithmetic:
  // it carries areaPercent and barsMastered but no discovered count, so it
  // cannot replace GET /api/bars, only GET /api/progress - and it is the
  // larger of those two (it also ships every badge and every badge-progress
  // entry, none of which this screen draws) and it needs the signed-in user's
  // handle to ask at all. Two requests either way; this is the cheaper pair.
  //
  // The cost that remains is real and is worth naming: GET /api/bars ships
  // every discovered bar to a screen that wants two integers. It is the same
  // list the map fetches on every visit (map/bars/useDiscoveredBars.ts), so it
  // is a request this application already makes routinely rather than a new
  // kind of load - but the honest fix, a count the server already knows how to
  // compute, is an API change and this block does not touch the API.
  useEffect(() => {
    let cancelled = false;
    Promise.all([getProgress(), getBars()])
      .then(([progress, bars]) => {
        if (cancelled) return;
        setStats({
          discovered: bars.bars.length,
          mastered: bars.bars.filter((bar) => bar.mastered).length,
          percent: progress.city.percent,
        });
      })
      .catch(() => {
        // Silent for the same reason as the backdrop, and all-or-nothing on
        // purpose: half a row of statistics - "24 bars discovered" beside a
        // blank where the percentage should be - reads as a broken screen,
        // where none of them reads as a screen that simply does not mention
        // them.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="screen screen--home">
      <BottomNav />
      <HomeBackdrop city={city} />
      <div className="screen__content screen__content--middle home">
        {/* The one screen where the wordmark is the subject rather than the
            signature, so it is the <h1> here and a plain span everywhere it is
            chrome (components/Wordmark.tsx). */}
        <Wordmark as="h1" prominence="hero" />
        <p className="home__tagline">Karlsruhe is waiting.</p>
      </div>
      <div className="screen__actions">
        <Link className="button button--primary" to="/map">
          Open the map
        </Link>
      </div>
      {/* Always in the document, empty or not: it reserves its row so that the
          numbers arriving a moment after the first paint cannot lift the
          button above them out from under a thumb already reaching for it. */}
      <div className="home__stats">
        {stats && (
          <ul className="home__stats-list">
            <li>{barCount(stats.discovered)} discovered</li>
            <li>{barCount(stats.mastered)} mastered</li>
            {/* One decimal, exactly as the city overview states the same
                figure - a start screen rounding it to "18%" while the city
                screen says "18.4%" is two answers to one question. */}
            <li>{stats.percent.toFixed(1)}% of Karlsruhe explored</li>
          </ul>
        )}
      </div>
    </main>
  );
}

interface HomeStats {
  readonly discovered: number;
  readonly mastered: number;
  readonly percent: number;
}

/** "1 bar", "24 bars" - a start screen saying "1 bars discovered" is a typo. */
function barCount(count: number): string {
  return `${count} ${count === 1 ? 'bar' : 'bars'}`;
}

// Absolutely positioned behind the words and out of the flow, which is the
// single decision that makes "degrade to something, never to nothing" true
// rather than aspirational: arriving late, arriving never, or arriving as a
// boundary with different bounds than expected, it cannot move a word of the
// screen in front of it. There is no placeholder box to collapse and no
// spinner to flash - before it resolves this renders nothing at all, and the
// screen is already complete without it.
//
// aria-hidden, unlike the same outline on the city overview: there it is a
// schematic map and the content of the screen, here it is a texture behind a
// wordmark, and announcing "map of Karlsruhe" to someone who cannot see it
// would promise information this drawing does not carry.
function HomeBackdrop({ city }: { city: BoundaryFeatureCollection | null }) {
  if (!city) {
    return null;
  }

  const points = city.features.flatMap((feature) => pointsOfGeometry(feature.geometry));
  if (points.length === 0) {
    return null;
  }
  const project = createProjector(computeBoundingBox(points), {
    width: BACKDROP_SIZE,
    height: BACKDROP_SIZE,
  });

  // Every feature concatenated into ONE path, and that is not tidiness. This
  // is a translucent fill (Section 8.1's ink, heavily fogged), and translucent
  // paint compounds: two overlapping paths, or a stroke over its own fill,
  // would darken exactly where they overlap and the screen would have a patch
  // nobody had reckoned the contrast of. One path painted once means the
  // darkest pixel of this backdrop is precisely the one blend that
  // App.branding.test.tsx computes the contrast floor against, everywhere and
  // always. `evenodd` is what makes the concatenation safe (geo/geojson-path.ts)
  // - it is also what subtracts interior rings correctly.
  const d = city.features.map((feature) => svgPathOfGeometry(feature.geometry, project)).join(' ');

  return (
    <svg
      className="home-backdrop"
      viewBox={`0 0 ${BACKDROP_SIZE} ${BACKDROP_SIZE}`}
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
      focusable="false"
    >
      <path className="home-backdrop__city" d={d} fillRule="evenodd" />
    </svg>
  );
}
