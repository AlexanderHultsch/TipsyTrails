import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getCityBoundary, getDistrictBoundaries, getProgress } from '../api/client.js';
import type { BoundaryFeatureCollection } from '../api/geo-types.js';
import { BottomNav } from '../components/BottomNav.js';
import { Wordmark } from '../components/Wordmark.js';
import { pointsOfGeometry, svgPathOfGeometry } from '../geo/geojson-path.js';
import { computeBoundingBox, createProjector } from '../geo/project.js';

// THE VIEWBOX IS TALLER THAN IT IS WIDE, and that is the whole framing. This
// drawing is stretched over the screen with preserveAspectRatio="slice", which
// scales to *cover*: the scale factor is the larger of viewportWidth/width and
// viewportHeight/height, and whichever axis loses is cropped. A 320x320 box on
// a 9:19.5 phone therefore came out at 2.6x with 54% of its width cut away -
// not a crop of Karlsruhe but a magnified fragment of one, bleeding off all
// four edges with no shape left in it.
//
// 1:2 is deliberately between the two aspects real phones have (9:16 = 0.56,
// 9:19.5 = 0.46), so `slice` crops a little of one axis on any of them and
// never much of either. `slice` rather than `meet` because a backdrop that
// letterboxes is a picture on the screen instead of the screen's ground.
const BACKDROP_WIDTH = 320;
const BACKDROP_HEIGHT = 640;

// The city is fitted into the *top* CITY_BAND_HEIGHT of that box rather than
// into all of it, which is what keeps it off the words. createProjector
// centres what it fits, so the city's centre lands at CITY_BAND_HEIGHT / 2 =
// 31% of the height whatever the city's own proportions are - and Karlsruhe,
// slightly wider than it is tall, then occupies roughly the top half. The
// bottom half is empty, and the bottom half is where .screen__actions and the
// 0.875rem row of figures sit (index.css). The busiest part of the drawing -
// the district edges - is over the hero wordmark, which is 2.5rem.
const CITY_BAND_HEIGHT = 400;
const BACKDROP_PADDING = 16;

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
// So the backdrop is built from what screens/CityOverview.tsx and
// screens/DistrictOverview.tsx already use - the real city outline from GET
// /static/<slug>/city.geojson and the real district edges from GET
// /static/<slug>/districts.geojson, projected by geo/project.ts and drawn as
// inline SVG. Real Karlsruhe, no WebGL, no tiles, no session, and the fog is
// the app's own ink composited over the paper (index.css) rather than a
// shader.
export function AppHome() {
  const [city, setCity] = useState<BoundaryFeatureCollection | null>(null);
  const [districts, setDistricts] = useState<BoundaryFeatureCollection | null>(null);
  const [stats, setStats] = useState<HomeStats | null>(null);

  // Two effects rather than one Promise.all, because the backdrop and the
  // numbers fail independently and neither may take the other down with it: a
  // city outline that 404s must not blank the three figures, and a progress
  // request that times out must not leave the screen without its atmosphere.
  //
  // THREE INDEPENDENT FETCHES ON THIS SCREEN, IN TWO GROUPS, AND THE GROUPING
  // IS THE DEGRADATION RULE. The two boundaries are one effect but not one
  // Promise.all: Promise.all is all-or-nothing, and all-or-nothing is exactly
  // wrong here, because the city fill is the backdrop and the district edges
  // are detail inside it. Districts that never arrive have to leave the fill
  // standing; a Promise.all would take the fill down with them and lose the
  // backdrop over a decoration on a decoration. The three figures below stay
  // all-or-nothing for the opposite reason, which is written out there.
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
    getDistrictBoundaries()
      .then((boundaries) => {
        if (!cancelled) setDistricts(boundaries);
      })
      .catch(() => {
        // Silent for the same reason, and one step further back: the city
        // fill is already drawn without this, so a district fetch that fails
        // costs the backdrop its interior detail and nothing else.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // WHERE THE THREE NUMBERS COME FROM: one request, and all three off it.
  // GET /api/progress answers the percent - the same city.percent
  // screens/CityOverview.tsx renders, so the two screens cannot disagree
  // about how much of Karlsruhe this player has walked - and, since the route
  // answers Section 7.6 in full, the two bar counts beside it. The server
  // scopes them to this caller, this city and bars that are still active,
  // which is the same set GET /api/bars returns and the map draws its markers
  // from: "7 bars mastered" here and seven emptied glasses out there are one
  // fact and not two.
  //
  // This screen used to ask GET /api/bars for those two integers and count
  // the list itself, which shipped every discovered bar - name, address,
  // coordinates, district, timestamps - to read a length and a filtered
  // length, on the screen every authenticated entry path lands on, and grew
  // with exactly the players who play most. The map still fetches that list
  // (map/bars/useDiscoveredBars.ts) because it draws every bar in it; a
  // screen that draws none of them has no business asking for it.
  //
  // GET /api/profile/:handle remains the wrong source for a different reason
  // than before: it carries areaPercent and barsMastered but no discovered
  // count, it ships every badge and every badge-progress entry that this
  // screen does not draw, and it needs the signed-in user's handle to ask at
  // all.
  useEffect(() => {
    let cancelled = false;
    getProgress()
      .then((progress) => {
        if (cancelled) return;
        setStats({
          discovered: progress.city.barsDiscovered,
          mastered: progress.city.barsMastered,
          percent: progress.city.percent,
        });
      })
      .catch(() => {
        // Silent for the same reason as the backdrop, and still
        // all-or-nothing: half a row of statistics - "24 bars discovered"
        // beside a blank where the percentage should be - reads as a broken
        // screen, where none of them reads as a screen that simply does not
        // mention them. That used to be a decision about combining two
        // requests with Promise.all; with one request behind all three
        // figures it is a property of the shape - one response, one setStats,
        // one `stats` object the row renders from or does not render at all -
        // and the outcome the player sees is unchanged.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="screen screen--home">
      <BottomNav />
      <HomeBackdrop city={city} districts={districts} />
      <div className="screen__content screen__content--middle home">
        {/* The one screen where the wordmark is the subject rather than the
            signature, so it is the <h1> here and a plain span everywhere it is
            chrome (components/Wordmark.tsx).
            It is also the one screen the chrome mark leads *to*, so here it
            leads nowhere: a link to the route you are already standing on is
            a control that visibly does nothing, which is worse than plain
            text. The hero form takes no `linksToStart`, so that is a fact
            about the type rather than about this call site remembering. */}
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
// wordmark. The district edges make it look more like a map than it did and
// change nothing about that - it is unlabelled, unreadable at this density,
// and half dissolved by the edge mask, so announcing "map of Karlsruhe" to
// someone who cannot see it would promise a map that can be read. The city
// overview and the district overview are that map, one tab away, and they are
// where the labels and the percentages are.
function HomeBackdrop({
  city,
  districts,
}: {
  city: BoundaryFeatureCollection | null;
  districts: BoundaryFeatureCollection | null;
}) {
  if (!city) {
    return null;
  }

  const points = city.features.flatMap((feature) => pointsOfGeometry(feature.geometry));
  if (points.length === 0) {
    return null;
  }

  // ONE PROJECTOR, FITTED TO THE CITY, AND BOTH LAYERS DRAWN THROUGH IT.
  // Fitting each collection to the box on its own would stretch the districts
  // to fill the frame and put the edges nowhere near the fill they belong
  // inside; fitting to the union of the two would make the frame depend on a
  // response that arrives later than the one it frames.
  //
  // The union happens to be identical today - the shipped districts.geojson
  // tiles Karlsruhe exactly, so the two bounding boxes agree to the last
  // decimal - and that is the reason to fit to the city rather than to both
  // rather than a reason it does not matter: the day a district file stops
  // tiling the city exactly, a frame computed from both would slide the whole
  // backdrop a beat after the first paint. It is computed from the one
  // collection this drawing cannot be drawn without.
  const project = createProjector(computeBoundingBox(points), {
    width: BACKDROP_WIDTH,
    height: CITY_BAND_HEIGHT,
    padding: BACKDROP_PADDING,
  });

  // TWO LAYERS, WHICH THE PREVIOUS VERSION OF THIS FUNCTION COULD NOT HAVE.
  // It concatenated every feature into one path because the fill was
  // translucent (rgba(28, 26, 23, 0.22)) and translucent paint compounds:
  // overlapping paths, or a stroke over its own fill, darken where they meet,
  // and the screen would have had a patch whose contrast nobody had reckoned.
  //
  // The fill is now the same colour pre-composited and painted OPAQUE
  // (index.css: ink 22% over paper is rgb(196, 192, 184)). Not one pixel of
  // the city changes value, and neither does the text contrast over it - but
  // opaque paint does not compound, so every pixel is exactly the colour it
  // was declared to be however many times it is painted. That is what makes
  // the district edges safe on top of the fill, and it is what makes the
  // shared border between two neighbouring districts - drawn twice, once from
  // each side's ring - the same grey as a border drawn once.
  //
  // Each layer is still one concatenated path, now for economy rather than
  // out of necessity: it is one shape at one colour, so it is one element.
  // `evenodd` is what makes the concatenation safe (geo/geojson-path.ts) and
  // is also what subtracts the city's interior rings correctly.
  const cityPath = city.features
    .map((feature) => svgPathOfGeometry(feature.geometry, project))
    .join(' ');
  const districtPath = (districts?.features ?? [])
    .map((feature) => svgPathOfGeometry(feature.geometry, project))
    .join(' ');

  return (
    <svg
      className="home-backdrop"
      viewBox={`0 0 ${BACKDROP_WIDTH} ${BACKDROP_HEIGHT}`}
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
      focusable="false"
    >
      <path className="home-backdrop__city" d={cityPath} fillRule="evenodd" />
      {districtPath !== '' && <path className="home-backdrop__districts" d={districtPath} />}
    </svg>
  );
}
