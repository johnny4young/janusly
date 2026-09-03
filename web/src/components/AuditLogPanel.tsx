/**
 * Audit-log viewer — mounted inside `OperationsPage` (Access section).
 *
 * Admin-only (the `GET /audit` route is `role: "admin"`). Lists the org's
 * audit trail newest-first with an action-prefix filter and cursor-based
 * "Load more" paging. Read-only: it owns its own load/refresh and never
 * mutates server state, so no `bumpPlatformVersion`.
 *
 * Used by `OperationsPage.tsx`.
 */

import React, { useEffect, useState } from "react";
import { LoadingSkeleton } from "./LoadingSkeleton";
import { ListChecks } from "lucide-react";

import { api } from "../api";
import { getResolvedLocale, useT } from "../i18n";
import { Button } from '@/components/ui/Button'
import { FormField } from '@/components/ui/Form'

/** One audit row as returned by `GET /audit`. `action` is a stable technical
 *  identifier shown verbatim (not translated); `metadata` is the redacted
 *  JSON the write chokepoint persisted. */
type AuditLogRow = {
  id: string;
  userId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: unknown;
  createdAt: string | null;
};

/** Keyset page envelope from `GET /audit`. */
type AuditLogPage = {
  rows: AuditLogRow[];
  nextCursor: string | null;
  hasMore: boolean;
};

const METADATA_PREVIEW_MAX = 120;

function metadataPreview(metadata: unknown): string {
  if (metadata == null) return "";
  try {
    const json = JSON.stringify(metadata);
    if (!json || json === "{}") return "";
    return json.length > METADATA_PREVIEW_MAX ? `${json.slice(0, METADATA_PREVIEW_MAX)}…` : json;
  } catch {
    return "";
  }
}

function buildAuditQuery(action: string, cursor: string | null): string {
  const qs = new URLSearchParams();
  if (action) qs.set("action", action);
  if (cursor) qs.set("cursor", cursor);
  const s = qs.toString();
  return s ? `/audit?${s}` : "/audit";
}

export function AuditLogPanel() {
  const { t } = useT();

  const [rows, setRows] = useState<AuditLogRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [filterInput, setFilterInput] = useState("");
  const [appliedAction, setAppliedAction] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // First page on mount and whenever the applied filter changes.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api(buildAuditQuery(appliedAction, null))
      .then((data) => {
        if (cancelled) return;
        const page = (data ?? {}) as AuditLogPage;
        setRows(Array.isArray(page.rows) ? page.rows : []);
        setCursor(page.nextCursor ?? null);
        setHasMore(Boolean(page.hasMore));
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : (t("audit.error")));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [appliedAction, t]);

  const loadMore = async () => {
    if (!cursor) return;
    setLoadingMore(true);
    setError(null);
    try {
      const page = (await api(buildAuditQuery(appliedAction, cursor))) as AuditLogPage;
      setRows((prev) => [...prev, ...(Array.isArray(page.rows) ? page.rows : [])]);
      setCursor(page.nextCursor ?? null);
      setHasMore(Boolean(page.hasMore));
    } catch (err) {
      setError(err instanceof Error ? err.message : (t("audit.error")));
    } finally {
      setLoadingMore(false);
    }
  };

  const applyFilter = (event: React.FormEvent) => {
    event.preventDefault();
    setAppliedAction(filterInput.trim());
  };

  const clearFilter = () => {
    setFilterInput("");
    setAppliedAction("");
  };

  const applyMemoryPreset = () => {
    setFilterInput("memory.");
    setAppliedAction("memory.");
  };

  return (
    <section className="we-budget-settings" aria-labelledby="audit-heading" data-testid="audit-log-panel">
      <header className="we-budget-settings__header">
        <ListChecks size={18} aria-hidden="true" />
        <h3 id="audit-heading">{t("audit.heading")}</h3>
      </header>
      <p className="helper-text">{t("audit.intro")}</p>

      <div className="we-audit-presets" role="group" aria-label={t("audit.presets.aria")}>
        <span>{t("audit.presets.label")}</span>
        <button
          type="button"
          className={`we-audit-preset${appliedAction === "memory." ? " we-audit-preset--active" : ""}`}
          aria-pressed={appliedAction === "memory."}
          onClick={applyMemoryPreset}
        >
          {t("audit.presets.memory")}
        </button>
      </div>

      <form className="we-budget-settings__form" onSubmit={applyFilter} noValidate>
        <FormField label={t("audit.filter.label")}>
          {(controlProps) => (
            <input
              {...controlProps}
              type="text"
              placeholder={t("audit.filter.placeholder")}
              value={filterInput}
              onChange={(e) => setFilterInput(e.target.value)}
            />
          )}
        </FormField>
        <Button variant="ghost" type="submit" >
          {t("audit.filter.apply")}
        </Button>
        {appliedAction && (
          <Button variant="ghost" type="button"  onClick={clearFilter}>
            {t("audit.filter.clear")}
          </Button>
        )}
      </form>

      {error && (
        <div className="we-budget-settings__error" role="alert">
          {error}
        </div>
      )}

      {loading ? (
        <LoadingSkeleton rows={4} label={t("audit.loading")} />
      ) : rows.length === 0 ? (
        <p className="we-budget-settings__status">{t("audit.empty")}</p>
      ) : (
        <>
          <div className="we-audit-table-wrap">
            <table className="we-table we-table--compact we-audit-table" aria-label={t("audit.list.aria")}>
              <thead>
                <tr>
                  <th>{t("audit.col.time")}</th>
                  <th>{t("audit.col.action")}</th>
                  <th>{t("audit.col.actor")}</th>
                  <th>{t("audit.col.target")}</th>
                  <th>{t("audit.col.details")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const target = row.targetType
                    ? `${row.targetType}${row.targetId ? `:${row.targetId}` : ""}`
                    : "—";
                  const details = metadataPreview(row.metadata);
                  return (
                    <tr key={row.id}>
                      <td>{row.createdAt ? new Date(row.createdAt).toLocaleString(getResolvedLocale()) : "—"}</td>
                      <td><code>{row.action}</code></td>
                      <td>{row.userId || "—"}</td>
                      <td>{target}</td>
                      <td>{details ? <code>{details}</code> : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {hasMore && (
            <Button variant="ghost"
              type="button"

              onClick={loadMore}
              disabled={loadingMore}
            >
              {loadingMore ? t("audit.loadingMore") : t("audit.loadMore")}
            </Button>
          )}
        </>
      )}
    </section>
  );
}
