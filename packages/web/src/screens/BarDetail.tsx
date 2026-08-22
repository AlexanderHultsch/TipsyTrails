import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ApiError, getBar, getCity } from '../api/client.js';
import type { Bar } from '../api/types.js';
import { BottomNav } from '../components/BottomNav.js';

// Section 8.3's bar detail row: name, address, district, mastered status, a
// community tag when applicable, and a Check in button. Mastered status and
// check-in both belong to Section 7.5 / Phase 5 - GET /api/bars/:id reports
// neither yet (packages/api/src/routes/bars.ts), so this screen shows only
// what the response actually carries. The Check in button itself is
// deliberately omitted rather than shown disabled: a disabled control would
// still need to know the on-site-radius eligibility Section 7.5 defines,
// which this phase has no way to compute, so a stand-in button would imply
// mechanics that do not exist yet rather than honestly showing none.
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
            {bar.source === 'community' && (
              <p className="bar-detail__tag">Added by the community</p>
            )}
          </>
        )}
      </div>
    </main>
  );
}
