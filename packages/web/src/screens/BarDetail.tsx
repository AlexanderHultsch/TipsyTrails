import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ApiError, getBar, getCity } from '../api/client.js';
import type { Bar } from '../api/types.js';
import { BottomNav } from '../components/BottomNav.js';
import { CocktailGlass } from '../components/CocktailGlass.js';
import { masteredStatusText } from '../components/cocktail-glass.js';

// Section 8.3's bar detail row: name, address, district, mastered status and
// a community tag when applicable. The mastered status is `GET
// /api/bars/:id`'s own `mastered` field (Section 5.7, computed per calling
// user in packages/api/src/routes/bars.ts) shown with the same cocktail
// glass the map marker and the bar sheet draw - one mark for a bar
// everywhere a bar is drawn (Section 8.1, components/cocktail-glass.ts).
//
// There is deliberately no Check in button here, and Section 7.5 says why:
// position tracking runs only on the map screen, so a check-in on this route
// would have no live position to judge on-site eligibility against. This is
// the linkable detail page and the sheet on the map is where a check-in
// happens.
export function BarDetail() {
  const { id } = useParams<{ id: string }>();
  const [bar, setBar] = useState<Bar | null>(null);
  const [districtName, setDistrictName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) {
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setBar(null);
    setDistrictName(null);

    getBar(id)
      .then((result) => {
        if (cancelled) {
          return;
        }
        setBar(result);
        // A second, best-effort fetch purely to turn districtId into a
        // name (Section 9.2's GET /api/city districts share the same ids
        // as bars.district_id) - its failure does not block showing the
        // bar itself, which is this screen's primary job.
        getCity()
          .then((city) => {
            if (cancelled) {
              return;
            }
            const district = city.districts.find((d) => d.id === result.districtId);
            setDistrictName(district?.name ?? null);
          })
          .catch(() => {});
      })
      .catch((err: unknown) => {
        if (cancelled) {
          return;
        }
        setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [id]);

  return (
    <main className="screen">
      <BottomNav />
      <div className="screen__content bar-detail">
        {loading && <p role="status">Loading…</p>}
        {error && (
          <p className="error-message" role="alert">
            {error}
          </p>
        )}
        {bar && (
          <>
            <h1>{bar.name}</h1>
            {bar.address && <p className="bar-detail__address">{bar.address}</p>}
            {districtName && <p className="bar-detail__district">{districtName}</p>}
            <p className="bar-detail__mastered">
              <CocktailGlass mastered={bar.mastered} />
              {masteredStatusText(bar.mastered)}
            </p>
            {bar.source === 'community' && (
              <p className="bar-detail__tag">Added by the community</p>
            )}
          </>
        )}
      </div>
    </main>
  );
}
