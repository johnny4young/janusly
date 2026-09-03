import { SimilarRunsCard } from '@janusly/web'

/**
 * Prior runs that failed the same way, ranked by similarity, so an operator
 * can see how this failure was resolved before committing to a fix. It is a
 * best-effort surface: it queries `GET /runs/semantic-search` with the failure
 * signature and renders nothing at all when semantic search is disabled or the
 * search returns nothing — absence is the correct fallback, never an error.
 *
 * The lookup is driven entirely by `failureSignature`, so one story is shown;
 * a second signature would return the same ranked shape.
 */
export function RankedMatches() {
  return <SimilarRunsCard failureSignature="HTTP 503 from billing.acme.com after 30000ms" />
}
